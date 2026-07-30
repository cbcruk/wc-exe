// Host driver for the bundler-interception PoC.
//
// Serves the project files + the browser builds of the bundlers, drives a
// headless Chromium through the build, writes the produced dist/ to disk, and
// verifies the output is a real, self-consistent bundle.
//
// On the rollup path it needs NO COOP/COEP headers: esbuild-wasm's async API
// and @rollup/browser both work without SharedArrayBuffer, unlike WebContainer
// and container2wasm. The rolldown path DOES need them — its wasi binding
// transfers a SharedArrayBuffer to a worker. Neither path uses a CDN.
//
// Usage:
//   pnpm --dir poc/vite-build-intercept install   # once
//   node poc/vite-build-intercept/run.mjs [projectDir] [--keep]

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')

const IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  '.DS_Store',
  'coverage',
])

function parseArgs(argv) {
  const rest = argv.slice(2)
  return {
    project:
      rest.find((a) => !a.startsWith('--')) ?? 'test/fixtures/sample-vite-app',
    keep: rest.includes('--keep'),
    bundler: rest.includes('--bundler=rolldown') ? 'rolldown' : 'rollup',
    // Skips lightningcss on the rolldown path. Exists because loading a second
    // wasm module measurably slows the bundle burst — see README.
    cssMinify: !rest.includes('--no-css-minify'),
  }
}

async function listFiles(root, base = '', extraIgnore = null) {
  const entries = await fs.readdir(path.join(root, base), {
    withFileTypes: true,
  })
  const out = []
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    if (extraIgnore?.has(e.name)) continue
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, rel, extraIgnore)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

function safeJoin(base, rel) {
  const full = path.resolve(base, ...rel.split('/'))
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`path escapes base: ${rel}`)
  }
  return full
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      await fs.access(c)
      return c
    } catch {
      continue
    }
  }
  throw new Error('Chrome not found — set CHROME_PATH')
}

function createApp({ projectDir, outDir, vendor, needsCoi }) {
  const app = new Hono()

  // Only the rolldown path needs this: its wasi binding posts a
  // SharedArrayBuffer to a worker, which requires cross-origin isolation.
  // @rollup/browser + esbuild-wasm need no such headers.
  if (needsCoi) {
    app.use('*', async (c, next) => {
      await next()
      c.header('Cross-Origin-Embedder-Policy', 'require-corp')
      c.header('Cross-Origin-Opener-Policy', 'same-origin')
    })
  }

  app.get('/', async (c) =>
    c.html(await fs.readFile(path.join(HERE, 'browser/index.html'), 'utf8'))
  )

  app.get('/poc/build.js', async () => {
    const body = await fs.readFile(path.join(HERE, 'browser/build.js'), 'utf8')
    return new Response(body, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
  })

  // Bundler browser builds, served straight from node_modules so their own
  // relative wasm fetches (rollup's bindings_wasm_bg.wasm) resolve.
  app.get('/vendor/:kind/:file{.+}', async (c) => {
    const kind = c.req.param('kind')
    const file = c.req.param('file')
    const base = vendor[kind]
    if (!base) return c.text('unknown vendor', 404)
    try {
      const body = await fs.readFile(safeJoin(base, file))
      const type = file.endsWith('.wasm')
        ? 'application/wasm'
        : 'text/javascript; charset=utf-8'
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      return c.text(`not found: ${file}`, 404)
    }
  })

  // Browser stubs for the node builtins @rolldown/browser still imports; the
  // page's import map points node:fs / node:url here.
  app.get('/shim/:file{.+}', async (c) => {
    try {
      const body = await fs.readFile(
        safeJoin(path.join(HERE, 'browser/shim'), c.req.param('file')),
        'utf8'
      )
      return new Response(body, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      })
    } catch {
      return c.text('not found', 404)
    }
  })

  app.get('/api/files', async (c) => c.json(await listFiles(projectDir)))

  // Paths inside node_modules, so the page can resolve bare specifiers without
  // downloading thousands of files it will never read.
  app.get('/api/dep-files', async (c) => {
    const root = path.join(projectDir, 'node_modules')
    try {
      await fs.access(root)
    } catch {
      return c.json([])
    }
    const rel = await listFiles(root, '', new Set(['.bin', '.cache']))
    return c.json(rel.map((p) => `node_modules/${p}`))
  })

  app.get('/api/files/raw', async (c) => {
    const rel = c.req.query('path')
    if (!rel) return c.text('missing path', 400)
    try {
      const body = await fs.readFile(safeJoin(projectDir, rel))
      return new Response(body, {
        headers: { 'content-type': 'application/octet-stream' },
      })
    } catch {
      return c.text(`not found: ${rel}`, 404)
    }
  })

  app.post('/api/dist', async (c) => {
    const rel = c.req.query('path')
    if (!rel) return c.text('missing path', 400)
    const full = safeJoin(outDir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, Buffer.from(await c.req.arrayBuffer()))
    return c.body(null, 204)
  })

  return app
}

/**
 * Check the emitted bundle is actually coherent, not just present: the HTML
 * must point at files that exist, the JS must be transformed (no TypeScript
 * left) and must contain the app's own code, and the CSS must be real.
 */
async function verify(outDir, { usesDynamicImport = false } = {}) {
  const problems = []
  const read = (p) => fs.readFile(path.join(outDir, p), 'utf8')

  const html = await read('index.html').catch(() => null)
  if (!html) return ['index.html missing']

  const jsRef = html.match(/src="\/([^"]+\.js)"/)?.[1]
  const cssRef = html.match(/href="\/([^"]+\.css)"/)?.[1]
  if (!jsRef) problems.push('HTML does not reference a built JS asset')
  if (!cssRef) problems.push('HTML does not reference a built CSS asset')

  let js = null
  if (jsRef) {
    js = await read(jsRef).catch(() => null)
    if (!js) problems.push(`referenced JS missing on disk: ${jsRef}`)
  }
  if (cssRef) {
    const css = await read(cssRef).catch(() => null)
    if (!css) problems.push(`referenced CSS missing on disk: ${cssRef}`)
    else if (!css.includes('#213547')) {
      problems.push('CSS asset does not contain the fixture stylesheet')
    }
  }

  if (js) {
    // TypeScript/JSX annotations must be gone (the transform actually ran).
    for (const [re, what] of [
      [/querySelector<HTML/, 'TypeScript generics'],
      [/:\s*HTMLButtonElement/, 'TypeScript type annotations'],
      [/:\s*JSX\.Element/, 'TSX return-type annotations'],
      [/<\/div>\s*\)/, 'untransformed JSX'],
    ]) {
      if (re.test(js)) problems.push(`JS still contains ${what}`)
    }
    // The app's own code must be bundled in (both fixtures render this text).
    if (!js.includes('count is')) {
      problems.push('bundled JS is missing the app code (module graph broken)')
    }
    // CSS must have been extracted out of the JS, like a vite build. Match a
    // value unique to the fixture stylesheet: react-dom itself ships a list of
    // CSS property names, so testing for 'font-family' false-positives.
    if (js.includes('#213547')) {
      problems.push('CSS leaked into the JS bundle instead of being extracted')
    }

    // Code-splitting: when the fixture uses a dynamic import(), the lazy module
    // must end up in a separate chunk that the entry references and that
    // actually exists on disk — not inlined into the entry.
    const jsFiles = (
      await fs.readdir(path.join(outDir, 'assets')).catch(() => [])
    ).filter((f) => f.endsWith('.js'))

    if (usesDynamicImport) {
      if (jsFiles.length < 2) {
        problems.push(
          `dynamic import did not produce a separate chunk (${jsFiles.length} JS file(s))`
        )
      }
      if (js.includes('LAZY_CHUNK_LOADED')) {
        problems.push('lazy module was inlined into the entry chunk')
      }
      // oxc (rolldown's minifier) emits string literals as backtick templates,
      // esbuild uses double quotes — accept either.
      const refs = [
        ...js.matchAll(/import\(\s*["'`]([^"'`]+\.js)["'`]\s*\)/g),
      ].map((m) => m[1])
      if (refs.length === 0) {
        problems.push('entry chunk contains no dynamic import() of a chunk')
      }
      for (const ref of refs) {
        const file = path.basename(ref)
        if (!jsFiles.includes(file)) {
          problems.push(`entry imports a chunk that is missing on disk: ${ref}`)
        }
      }
      const marked = []
      for (const f of jsFiles) {
        const body = await fs
          .readFile(path.join(outDir, 'assets', f), 'utf8')
          .catch(() => '')
        if (body.includes('LAZY_CHUNK_LOADED')) marked.push(f)
      }
      if (marked.length !== 1) {
        problems.push(
          `expected exactly one chunk to carry the lazy module, found ${marked.length}`
        )
      }
    }
  }

  return problems
}

/**
 * The strongest check available: serve the emitted dist/ and actually run it.
 * Proves the HTML, the bundled JS and the extracted CSS are wired together and
 * that the transformed TypeScript behaves — not merely that files were written.
 */
async function verifyBuiltAppRuns(outDir, chromePath) {
  const app = new Hono()
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  }
  app.get('/*', async (c) => {
    let rel = decodeURIComponent(new URL(c.req.url).pathname).replace(
      /^\/+/,
      ''
    )
    if (rel === '') rel = 'index.html'
    try {
      const body = await fs.readFile(safeJoin(outDir, rel))
      const type = types[path.extname(rel)] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      return c.text('not found', 404)
    }
  })

  const srv = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) =>
      resolve({ server: s, port: info.port })
    )
    s.on('error', reject)
  })

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })

  const problems = []
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => problems.push(`runtime error: ${e.message}`))
    page.on('requestfailed', (r) =>
      problems.push(`asset failed to load: ${r.url()}`)
    )

    await page.goto(`http://localhost:${srv.port}/`, {
      waitUntil: 'networkidle2',
    })

    // The mount node differs per fixture (#app for vanilla, #root for React).
    const rendered = await page
      .$eval('#app, #root', (el) => el.innerHTML)
      .catch(() => '')
    if (!/Sample .* App/.test(rendered)) {
      problems.push('app did not render into its mount node')
    }

    // CSS asset applied? The stylesheet sets a font-family on :root.
    const font = await page.evaluate(
      () => getComputedStyle(document.documentElement).fontFamily
    )
    if (!/Inter|system-ui/.test(font)) {
      problems.push(`stylesheet not applied (font-family: ${font})`)
    }

    // Code-splitting at runtime: clicking must fetch and execute the lazy
    // chunk. This is what proves the split chunk is genuinely loadable, not
    // merely present on disk.
    const hasLazy = (await page.$('#lazy')) !== null
    if (hasLazy) {
      const before = await page.$eval('#lazy-out', (el) => el.textContent)
      if (before !== '') {
        problems.push(`lazy output was populated before loading: "${before}"`)
      }
      await page.click('#lazy')
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('#lazy-out')?.textContent ===
            'LAZY_CHUNK_LOADED',
          { timeout: 10000 }
        )
      } catch {
        const got = await page.$eval('#lazy-out', (el) => el.textContent)
        problems.push(`lazy chunk never loaded (#lazy-out = "${got}")`)
      }
    }

    // The transformed TypeScript actually works: click increments the counter.
    const before = await page.$eval('#counter', (el) => el.textContent)
    await page.click('#counter')
    const after = await page.$eval('#counter', (el) => el.textContent)
    if (before !== 'count is 0' || after !== 'count is 1') {
      problems.push(`counter behaviour wrong: "${before}" -> "${after}"`)
    }
  } finally {
    await browser.close()
    await new Promise((r) => srv.server.close(() => r()))
  }

  return problems
}

async function main() {
  const { project, keep, bundler, cssMinify } = parseArgs(process.argv)
  const projectDir = path.resolve(REPO_ROOT, project)
  const outDir = path.join(HERE, 'out')

  const vendor = {
    rollup: path.join(HERE, 'node_modules/@rollup/browser/dist/es'),
    esbuild: path.join(HERE, 'node_modules/esbuild-wasm'),
    rolldown: path.join(HERE, 'vendor/rolldown'),
    // vite 8's CSS tool, used by the rolldown path only.
    lightningcss: path.join(HERE, 'node_modules/lightningcss-wasm'),
    // lightningcss-wasm's napi glue, resolved via the page's import map.
    'napi-wasm': path.join(
      HERE,
      'node_modules/lightningcss-wasm/node_modules/napi-wasm'
    ),
  }
  const needed =
    bundler === 'rolldown'
      ? ['rolldown', ...(cssMinify ? ['lightningcss', 'napi-wasm'] : [])]
      : ['rollup', 'esbuild']
  for (const [k, dir] of Object.entries(vendor).filter(([k]) =>
    needed.includes(k)
  )) {
    try {
      await fs.access(dir)
    } catch {
      throw new Error(
        `${k} browser build not found at ${dir}\n` +
          (k === 'rolldown'
            ? 'run: node poc/vite-build-intercept/scripts/prebundle-rolldown.mjs'
            : 'run: pnpm --dir poc/vite-build-intercept install')
      )
    }
  }

  console.log(
    '\nwc-exe PoC — production build in the browser via bundler interception'
  )
  console.log(
    `  bundler: ${bundler}${bundler === 'rolldown' ? '  (vite 8 pipeline: @rolldown/browser)' : '  (vite 5 pipeline: @rollup/browser + esbuild-wasm)'}`
  )
  console.log(`  project: ${projectDir}`)
  console.log(`  output:  ${outDir}`)
  console.log(
    `  headers: ${
      bundler === 'rolldown'
        ? 'COOP/COEP (rolldown wasi needs SharedArrayBuffer)'
        : 'none (no COOP/COEP needed)'
    }  vendors: local\n`
  )

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const app = createApp({
    projectDir,
    outDir,
    vendor,
    needsCoi: bundler === 'rolldown',
  })
  const server = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) =>
      resolve({ server: s, port: info.port })
    )
    s.on('error', reject)
  })
  const url = `http://localhost:${server.port}`

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: await findChrome(),
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })

  let result
  try {
    const page = await browser.newPage()
    page.on('console', (m) => {
      const t = m.text()
      if (t.startsWith('[poc]')) console.log(' ', t)
    })
    page.on('pageerror', (e) => console.error('  [browser error]', e.message))

    const hostStart = performance.now()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__POC_READY__ === true, {
      timeout: 60000,
    })
    result = await page.evaluate(
      (b, css) => window.__pocBuild({ bundler: b, cssMinify: css }),
      bundler,
      cssMinify
    )
    result.hostWallclockMs = Math.round(performance.now() - hostStart)
  } finally {
    await browser.close()
    await new Promise((r) => server.server.close(() => r()))
  }

  if (!result?.ok) {
    console.error('\nBUILD FAILED\n')
    console.error(result?.error ?? 'unknown error')
    process.exit(1)
  }

  const usesDynamicImport =
    result.outputs.filter((o) => o.path.endsWith('.js')).length > 1
  const staticProblems = await verify(outDir, { usesDynamicImport })
  const runtimeProblems = await verifyBuiltAppRuns(outDir, await findChrome())
  const problems = [...staticProblems, ...runtimeProblems]

  console.log('\n=== OUTPUT ===')
  for (const o of result.outputs) {
    console.log(`  ${o.path.padEnd(34)} ${String(o.bytes).padStart(7)} B`)
  }

  console.log('\n=== TIMING ===')
  console.log(
    JSON.stringify(
      { ...result.timings, hostWallclockMs: result.hostWallclockMs },
      null,
      2
    )
  )

  console.log('\n=== VERIFY ===')
  if (staticProblems.length === 0) {
    console.log('  ✓ static: HTML→assets resolve, TS transformed,')
    console.log('    module graph bundled, CSS extracted out of JS')
  } else {
    for (const p of staticProblems) console.log(`  ✗ static: ${p}`)
  }
  if (runtimeProblems.length === 0) {
    console.log('  ✓ runtime: built app renders, stylesheet applies,')
    console.log('    counter increments on click (transformed TS behaves)')
  } else {
    for (const p of runtimeProblems) console.log(`  ✗ runtime: ${p}`)
  }

  if (!keep) {
    console.log(
      `\n(kept output at ${outDir} — pass nothing to keep, it is gitignored)`
    )
  }

  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nPoC error:', err.message)
  process.exit(1)
})
