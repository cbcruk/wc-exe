// Host driver for the bundler-interception PoC.
//
// Serves the project files + the browser builds of the bundlers, drives a
// headless Chromium through the build, writes the produced dist/ to disk, and
// verifies the output is a real, self-consistent bundle.
//
// It needs COOP/COEP headers: @rolldown/browser's wasi binding transfers a
// SharedArrayBuffer to a worker, so cross-origin isolation is mandatory — the
// same requirement WebContainer and container2wasm carry. It does NOT use a
// CDN; the bundler is served out of this package.
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
import crypto from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')

/**
 * Skipped when scanning the *project*. `dist` and `coverage` are the project's
 * own build output, not input.
 *
 * Deliberately not reused for node_modules: a dependency's `dist/` is the part
 * that gets imported. Applying this set there silently dropped every package
 * that ships from `dist/` — the build then resolved nothing and emitted an
 * external import, with only a warning to say so. `sample-exports-app` exists
 * partly because it caught that.
 */
const IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  '.DS_Store',
  'coverage',
])

/** Skipped when scanning node_modules: metadata, never module sources. */
const DEP_IGNORE = new Set(['.bin', '.cache'])

function parseArgs(argv) {
  const rest = argv.slice(2)
  return {
    project:
      rest.find((a) => !a.startsWith('--')) ?? 'test/fixtures/sample-vite-app',
    keep: rest.includes('--keep'),
    // Skips lightningcss. Exists because loading a second
    // wasm module measurably slows the bundle burst — see README.
    cssMinify: !rest.includes('--no-css-minify'),
    // Disables the __vitePreload equivalent, so its effect can be A/B'd.
    preload: !rest.includes('--no-preload'),
    // How the project reaches the bundler.
    //   plugin (default) — through resolveId/load, with our own resolver
    //   memfs            — written into rolldown's own filesystem, so its
    //                      native resolver does the work
    vfs: rest.includes('--vfs=memfs') ? 'memfs' : 'plugin',
    // memfs only. The default fills the volume lazily — manifest and
    // directories up front, file contents faulted in through synchronous XHR
    // when the bundler opens one. `--eager` restores the whole-tree transfer,
    // so the difference stays measurable.
    lazy: !rest.includes('--eager'),
    // Ships every node_modules file to the volume, including ones that cannot
    // be a module. Exists so the filter's effect can be A/B'd.
    bulkFilter: !rest.includes('--no-bulk-filter'),
    // Artificial per-chunk latency when serving the built app for the runtime
    // check. Makes a request waterfall visible; 0 keeps normal runs fast.
    chunkDelayMs: Number(
      rest.find((a) => a.startsWith('--chunk-delay='))?.split('=')[1] ?? 0
    ),
  }
}

async function listFiles(root, base = '', ignore = IGNORE) {
  const entries = await fs.readdir(path.join(root, base), {
    withFileTypes: true,
  })
  const out = []
  for (const e of entries) {
    if (ignore.has(e.name)) continue
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, rel, ignore)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

/** Same 8-hex-char digest the page uses when it rehashes a rewritten chunk. */
function sha8(text) {
  return crypto
    .createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, 8)
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

/**
 * Extensions that cannot be a JavaScript module, and so are never worth sending
 * to the volume in `--vfs=memfs`.
 *
 * This is a content filter, not a resolver: it decides nothing about *where* a
 * specifier points, which is the job memfs mode exists to hand back to
 * rolldown. Dropping it (`--no-bulk-filter`) only makes the transfer bigger.
 */
const UNIMPORTABLE_EXTENSIONS = new Set([
  '.map',
  '.md',
  '.markdown',
  '.flow',
  // a native addon; the browser build could never load one
  '.node',
])

/** Whether a node_modules file is worth putting in the volume. */
async function worthSending(full, rel) {
  const base = path.basename(rel)
  if (/\.d\.[cm]?ts$/.test(base)) return false // type declarations only
  const ext = path.extname(base)
  if (UNIMPORTABLE_EXTENSIONS.has(ext)) return false

  // Extensionless files are the expensive case — the React fixture's
  // node_modules carries two 9 MB esbuild binaries (vite's own dependency),
  // half its total weight. A module has to
  // be text, so sniff for a NUL rather than guessing from the name (LICENSE
  // and bin/rollup are both extensionless, and only one is a binary).
  if (ext === '') {
    let handle
    try {
      handle = await fs.open(full, 'r')
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(1024),
        0,
        1024,
        0
      )
      return !buffer.subarray(0, bytesRead).includes(0)
    } catch {
      return true // unreadable header; let the normal read decide
    } finally {
      await handle?.close()
    }
  }
  return true
}

function createApp({ projectDir, outDir, vendor, bulkFilter }) {
  const app = new Hono()

  // Mandatory: rolldown's wasi binding posts a SharedArrayBuffer to a worker,
  // which requires cross-origin isolation.
  app.use('*', async (c, next) => {
    await next()
    c.header('Cross-Origin-Embedder-Policy', 'require-corp')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
  })

  app.get('/', async (c) =>
    c.html(await fs.readFile(path.join(HERE, 'browser/index.html'), 'utf8'))
  )

  app.get('/poc/build.js', async () => {
    const body = await fs.readFile(path.join(HERE, 'browser/build.js'), 'utf8')
    return new Response(body, {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
  })

  // The bundler's browser build, served so its own relative wasm fetch
  // (rolldown-binding.wasm32-wasi.wasm) resolves next to it.
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
    const rel = await listFiles(root, '', DEP_IGNORE)
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

  // Everything, in one response, for `--vfs=memfs`.
  //
  // Used by `--vfs=memfs --eager`, where the whole tree has to arrive before
  // the build starts, so the alternative is ~2,150 round trips. Framing is
  // `u32 pathLen | path | u32 bodyLen | body`, repeated; binary so non-UTF-8
  // files inside packages survive.
  app.get('/api/bulk', async () => {
    const sources = await listFiles(projectDir)
    let deps = []
    const depRoot = path.join(projectDir, 'node_modules')
    try {
      await fs.access(depRoot)
      deps = (await listFiles(depRoot, '', DEP_IGNORE)).map(
        (p) => `node_modules/${p}`
      )
    } catch {
      // no dependencies installed; sources alone
    }

    const parts = []
    let skipped = 0
    for (const rel of [...sources, ...deps]) {
      const full = safeJoin(projectDir, rel)
      if (
        bulkFilter &&
        rel.startsWith('node_modules/') &&
        !(await worthSending(full, rel))
      ) {
        skipped++
        continue
      }
      let body
      try {
        body = await fs.readFile(full)
      } catch {
        continue // vanished or unreadable (dangling symlink); skip it
      }
      const name = Buffer.from(rel, 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(name.length, 0)
      const size = Buffer.alloc(4)
      size.writeUInt32BE(body.length, 0)
      parts.push(header, name, size, body)
    }
    const payload = Buffer.concat(parts)
    if (skipped) {
      console.log(
        `  [host] bulk: ${skipped} unimportable dependency files skipped, ` +
          `${(payload.length / 1048576).toFixed(1)} MB sent`
      )
    }
    return new Response(payload, {
      headers: { 'content-type': 'application/octet-stream' },
    })
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
 * Optional per-project assertions, from `wc-exe-verify.json` at the project
 * root.
 *
 * The checks below used to hardcode this repo's fixtures — `#213547` from their
 * stylesheet, `count is` from their counter, `Sample … App` from their heading.
 * That was fine while the only thing that built was a fixture. Now that a stock
 * `npm create vite` template builds, those strings turn every outside project
 * into three false failures and hide whatever really went wrong.
 *
 * So the checks split in two. The generic ones below hold for any project and
 * always run; the ones that need to know what the app says live in this file,
 * and a project without one simply gets the generic set.
 *
 *   cssMarker        a string the emitted CSS must contain, and the JS must not
 *   jsMarker         a string the bundled JS must contain
 *   lazyMarker       a string that must appear in exactly one non-entry chunk
 *   renderedText     regex the mount node's HTML must match
 *   fontFamily       regex the computed font-family must match
 *   counter          { selector, before, after } — a click that must change text
 *   lazy             { trigger, output, text } — a click that must load a chunk
 *   mustContain      strings the bundle must contain (was resolution-expectations)
 *   mustNotContain   strings the bundle must not contain
 */
async function loadExpectations(projectDir) {
  const raw = await fs
    .readFile(path.join(projectDir, 'wc-exe-verify.json'), 'utf8')
    .catch(() => null)
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`wc-exe-verify.json is not valid JSON: ${err.message}`)
  }
}

/**
 * Check the emitted bundle is actually coherent, not just present: the HTML
 * must point at files that exist, the JS must be transformed (no TypeScript
 * left), and the CSS must have been extracted out of it.
 */
async function verify(
  outDir,
  { usesDynamicImport = false, expectPreload = false, expect = {} } = {}
) {
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
  let css = null
  if (cssRef) {
    css = await read(cssRef).catch(() => null)
    if (!css) problems.push(`referenced CSS missing on disk: ${cssRef}`)
    else if (expect.cssMarker && !css.includes(expect.cssMarker)) {
      problems.push(`CSS asset does not contain ${expect.cssMarker}`)
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
    if (expect.jsMarker && !js.includes(expect.jsMarker)) {
      problems.push(
        `bundled JS is missing ${expect.jsMarker} (module graph broken)`
      )
    }

    // CSS must have been extracted out of the JS, like a vite build. Generic
    // version of what used to be a hardcoded `#213547`: take a slice out of the
    // middle of the emitted stylesheet and require the JS not to contain it.
    // Sampling the middle avoids the leading `:root{` that a JS-in-CSS string
    // could plausibly share, and works for any project's stylesheet.
    if (css && css.length >= 80) {
      const probe = css.slice(
        Math.floor(css.length / 2),
        Math.floor(css.length / 2) + 40
      )
      if (js.includes(probe)) {
        problems.push(
          'CSS leaked into the JS bundle instead of being extracted'
        )
      }
    }

    // Code-splitting: when the fixture uses a dynamic import(), the lazy module
    // must end up in a separate chunk that the entry references and that
    // actually exists on disk — not inlined into the entry.
    const jsFiles = (
      await fs.readdir(path.join(outDir, 'assets')).catch(() => [])
    ).filter((f) => f.endsWith('.js'))

    // Dependency-resolution shapes (a fixture opts in with
    // wc-exe-verify.json). Each shape ships a `browser` file and a
    // `node` file with different markers, so picking the wrong one is a silent
    // success otherwise: the build still works, it just bundles the wrong
    // source. Checking the absence matters as much as the presence.
    if (expect.mustContain || expect.mustNotContain) {
      const allJs = (
        await Promise.all(jsFiles.map((f) => read(`assets/${f}`)))
      ).join('\n')
      for (const marker of expect.mustContain ?? []) {
        if (!allJs.includes(marker)) {
          problems.push(`resolution: bundle is missing ${marker}`)
        }
      }
      for (const marker of expect.mustNotContain ?? []) {
        if (allJs.includes(marker)) {
          problems.push(
            `resolution: bundle contains ${marker} — the wrong variant was resolved`
          )
        }
      }
    }

    // Assets: every hashed asset URL the bundle references must exist on disk.
    // Emitting the reference and not the file is a build that looks fine until
    // it 404s in a browser.
    const assetRefs = [
      ...js.matchAll(
        /["'`](\/assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm))["'`]/g
      ),
    ].map((m) => m[1])
    for (const ref of [...new Set(assetRefs)]) {
      try {
        await fs.access(path.join(outDir, ref.replace(/^\//, '')))
      } catch {
        problems.push(`bundle references an asset that is missing: ${ref}`)
      }
    }

    if (usesDynamicImport) {
      if (jsFiles.length < 2) {
        problems.push(
          `dynamic import did not produce a separate chunk (${jsFiles.length} JS file(s))`
        )
      }
      if (expect.lazyMarker && js.includes(expect.lazyMarker)) {
        problems.push('lazy module was inlined into the entry chunk')
      }
      // oxc (rolldown's minifier) emits string literals as backtick
      // templates, hence the quote class.
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
      if (expect.lazyMarker) {
        const marked = []
        for (const f of jsFiles) {
          const body = await fs
            .readFile(path.join(outDir, 'assets', f), 'utf8')
            .catch(() => '')
          if (body.includes(expect.lazyMarker)) marked.push(f)
        }
        if (marked.length !== 1) {
          problems.push(
            `expected exactly one chunk to carry the lazy module, found ${marked.length}`
          )
        }
      }

      // Preload: when a lazily-imported chunk has its own dependencies, the
      // entry must ship the helper and a non-empty dep list for it, otherwise
      // the browser only discovers them after fetching the chunk.
      if (expectPreload) {
        if (!js.includes('__wcPreload')) {
          problems.push('entry chunk is missing the __wcPreload helper')
        }
        const depLists = [...js.matchAll(/__wcPreload\([^,]+,\s*(\[[^\]]*\])/g)]
          .map((m) => {
            try {
              return JSON.parse(m[1])
            } catch {
              return null
            }
          })
          .filter(Boolean)
        if (depLists.length === 0) {
          problems.push('no __wcPreload call with a dep list found in entry')
        }
        const allDeps = depLists.flat()
        if (allDeps.length === 0) {
          problems.push(
            'preload dep lists are all empty despite chunks having dependencies'
          )
        }
        for (const dep of allDeps) {
          if (!jsFiles.includes(path.basename(dep))) {
            problems.push(`preload dep does not exist on disk: ${dep}`)
          }
        }

        // Hash coherence: a chunk rewritten after bundling must have been
        // rehashed, so its filename identifies its actual bytes. Without this
        // two different builds can emit the same name with different content.
        for (const f of jsFiles) {
          const body = await fs
            .readFile(path.join(outDir, 'assets', f), 'utf8')
            .catch(() => '')
          if (!body.includes('function __wcPreload')) continue
          const stamped = f.match(/-([^-.]+)\.js$/)?.[1]
          if (stamped !== sha8(body)) {
            problems.push(
              `rewritten chunk's name does not match its content hash: ${f}`
            )
          }
        }
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
async function verifyBuiltAppRuns(
  outDir,
  chromePath,
  chunkDelayMs = 0,
  expect = {}
) {
  const app = new Hono()
  // Content types matter here, not just for tidiness. A browser will sniff a
  // PNG out of `application/octet-stream` and render it, but it deliberately
  // will not do that for SVG — so serving one with the wrong type makes a
  // perfectly good build fail the image check. That is what the first run
  // against outside projects reported, three times.
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
  }
  app.get('/*', async (c) => {
    let rel = decodeURIComponent(new URL(c.req.url).pathname).replace(
      /^\/+/,
      ''
    )
    if (rel === '') rel = 'index.html'
    // Latency on chunk requests only — enough to expose a waterfall without
    // slowing the page load itself.
    if (chunkDelayMs > 0 && rel.startsWith('assets/') && rel.endsWith('.js')) {
      await new Promise((r) => setTimeout(r, chunkDelayMs))
    }
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
  let lazyLoadMs = null
  try {
    // Anything thrown in here becomes a problem rather than ending the run: a
    // build broken enough to crash the page usually has static problems too,
    // and those are the ones that say *why*. Losing them to the first
    // exception is how a resolution failure reads as "no #counter".
    await runRuntimeChecks()
  } catch (err) {
    problems.push(`runtime check aborted: ${err.message}`)
  } finally {
    await browser.close()
    await new Promise((r) => srv.server.close(() => r()))
  }
  return { problems, lazyLoadMs }

  async function runRuntimeChecks() {
    const page = await browser.newPage()
    page.on('pageerror', (e) => problems.push(`runtime error: ${e.message}`))
    page.on('requestfailed', (r) =>
      problems.push(`asset failed to load: ${r.url()}`)
    )

    await page.goto(`http://localhost:${srv.port}/`, {
      waitUntil: 'networkidle2',
    })

    // Generic: the app put *something* on the page. A build whose entry never
    // executed leaves the mount node as the empty div the HTML shipped, so this
    // catches a broken module graph without knowing what the app says.
    const rendered = await page.evaluate(() => {
      const mount = document.querySelector('#app, #root, main, body')
      return mount ? mount.innerHTML.trim() : ''
    })
    if (rendered.length < 20) {
      problems.push(
        `app rendered nothing into the page (${rendered.length} chars)`
      )
    }
    if (
      expect.renderedText &&
      !new RegExp(expect.renderedText).test(rendered)
    ) {
      problems.push(`rendered markup does not match /${expect.renderedText}/`)
    }

    // Generic: the stylesheet is attached and the browser parsed it. A 404 or a
    // malformed file leaves zero rules, which no amount of markup can fake.
    const cssRules = await page.evaluate(() =>
      [...document.styleSheets].reduce((n, sheet) => {
        try {
          return n + sheet.cssRules.length
        } catch {
          return n
        }
      }, 0)
    )
    const hasCssAsset = await fs
      .readFile(path.join(outDir, 'index.html'), 'utf8')
      .then((h) => /href="\/[^"]+\.css"/.test(h))
      .catch(() => false)
    if (hasCssAsset && cssRules === 0) {
      problems.push('stylesheet is referenced but contributed no rules')
    }

    if (expect.fontFamily) {
      const font = await page.evaluate(
        () => getComputedStyle(document.documentElement).fontFamily
      )
      if (!new RegExp(expect.fontFamily).test(font)) {
        problems.push(`stylesheet not applied (font-family: ${font})`)
      }
    }

    // Code-splitting at runtime: clicking must fetch and execute the lazy
    // chunk. This is what proves the split chunk is genuinely loadable, not
    // merely present on disk.
    if (expect.lazy) {
      const { trigger, output, text } = expect.lazy
      const before = await page.$eval(output, (el) => el.textContent)
      if (before !== '') {
        problems.push(`lazy output was populated before loading: "${before}"`)
      }
      const started = performance.now()
      await page.click(trigger)
      try {
        await page.waitForFunction(
          (sel, want) => document.querySelector(sel)?.textContent === want,
          { timeout: 15000 },
          output,
          text
        )
        lazyLoadMs = Math.round(performance.now() - started)
      } catch {
        const got = await page.$eval(output, (el) => el.textContent)
        problems.push(`lazy chunk never loaded (${output} = "${got}")`)
      }
    }

    // Assets actually decode. `naturalWidth` is 0 for an image that failed to
    // load, so this separates "the URL is in the HTML" from "the browser got
    // bytes it could use" — which is the difference between an inlined data URI
    // that is malformed and one that works.
    //
    // The wait matters: images inserted by the app start loading after
    // `networkidle2`, and reading `naturalWidth` before they settle reports 0
    // for pictures that are perfectly fine. That false positive showed up on
    // the first run of this check.
    await page
      .waitForFunction(() => [...document.images].every((i) => i.complete), {
        timeout: 10000,
      })
      .catch(() => problems.push('images never finished loading'))
    const images = await page.$$eval('img', (nodes) =>
      nodes.map((n) => ({
        id: n.id,
        src: n.getAttribute('src')?.slice(0, 24) ?? '',
        width: n.naturalWidth,
      }))
    )
    for (const img of images) {
      if (img.width === 0) {
        problems.push(`image did not load: #${img.id} src="${img.src}…"`)
      }
    }

    // The transformed TypeScript actually behaves: a click changes the text.
    if (expect.counter) {
      const { selector, before: want, after: then } = expect.counter
      const before = await page.$eval(selector, (el) => el.textContent)
      await page.click(selector)
      const after = await page.$eval(selector, (el) => el.textContent)
      if (before !== want || after !== then) {
        problems.push(`counter behaviour wrong: "${before}" -> "${after}"`)
      }
    }
  }
}

async function main() {
  const {
    project,
    keep,
    cssMinify,
    preload,
    vfs,
    lazy,
    bulkFilter,
    chunkDelayMs,
  } = parseArgs(process.argv)

  if (!lazy && vfs !== 'memfs') {
    console.error('\n--eager applies to --vfs=memfs only.\n')
    process.exit(1)
  }

  const projectDir = path.resolve(REPO_ROOT, project)
  const outDir = path.join(HERE, 'out')
  const expect = await loadExpectations(projectDir)

  const vendor = {
    rolldown: path.join(HERE, 'vendor/rolldown'),
    // vite 8's CSS tool, matching the toolchain rolldown comes from.
    lightningcss: path.join(HERE, 'node_modules/lightningcss-wasm'),
    // lightningcss-wasm's napi glue, resolved via the page's import map.
    'napi-wasm': path.join(
      HERE,
      'node_modules/lightningcss-wasm/node_modules/napi-wasm'
    ),
  }
  const needed = [
    'rolldown',
    ...(cssMinify ? ['lightningcss', 'napi-wasm'] : []),
  ]
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
  console.log('  bundler: rolldown  (@rolldown/browser, vite 8 toolchain)')
  console.log(
    `  vfs:     ${
      vfs === 'memfs'
        ? `memfs${lazy ? '' : '+eager'}  (rolldown's own resolver walks the volume)`
        : 'plugin (resolveId/load, with our resolver)'
    }`
  )
  console.log(`  project: ${projectDir}`)
  console.log(`  output:  ${outDir}`)
  console.log(
    '  headers: COOP/COEP (rolldown wasi needs SharedArrayBuffer)' +
      '  vendors: local\n'
  )

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const app = createApp({
    projectDir,
    outDir,
    vendor,
    bulkFilter,
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
      (css, pre, v, lz) =>
        window.__pocBuild({ cssMinify: css, preload: pre, vfs: v, lazy: lz }),
      cssMinify,
      preload,
      vfs,
      lazy
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
  // Preload only matters when a lazily-imported chunk has dependencies of its
  // own, i.e. the bundler emitted a shared chunk beyond entry + one lazy chunk.
  const jsOutputs = result.outputs.filter((o) => o.path.endsWith('.js'))
  const staticProblems = await verify(outDir, {
    usesDynamicImport,
    expectPreload: preload && jsOutputs.length > 2,
    expect,
  })
  const { problems: runtimeProblems, lazyLoadMs } = await verifyBuiltAppRuns(
    outDir,
    await findChrome(),
    chunkDelayMs,
    expect
  )
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

  if (lazyLoadMs !== null) {
    console.log(
      `\n=== LAZY LOAD ===\n  click -> rendered: ${lazyLoadMs} ms` +
        (chunkDelayMs ? `  (per-chunk delay ${chunkDelayMs} ms)` : '') +
        `  preload: ${preload ? 'on' : 'off'}`
    )
  }

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
