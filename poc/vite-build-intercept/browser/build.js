// Browser-side production build via bundler interception.
//
// The thesis under test (docs/virtual-filesystem.md §2 layer C, §9): a
// production bundle can be produced entirely in a browser tab by swapping the
// native bundler binaries for their browser builds — rollup -> @rollup/browser,
// esbuild -> esbuild-wasm — and feeding them a virtual filesystem instead of
// node:fs.
//
// This reimplements what `vite build` DOES for a vanilla app (discover the
// entry from index.html, transform TS, extract CSS, emit hashed assets,
// rewrite the HTML). It is NOT vite itself running — see README for why that
// distinction matters and what it does and does not prove.

import { rollup } from '/vendor/rollup/rollup.browser.js'
import * as esbuild from '/vendor/esbuild/esm/browser.min.js'

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']
const RESOLVE_INDEX = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs']

/** In-memory project files: VFS path (no leading slash) -> text. */
const vfs = new Map()

function log(...args) {
  console.log('[poc]', ...args)
}

// ---------------------------------------------------------------------------
// VFS
// ---------------------------------------------------------------------------

async function loadProjectIntoVfs() {
  const manifest = await fetch('/api/files')
  if (!manifest.ok) throw new Error(`manifest failed: ${manifest.status}`)
  const paths = await manifest.json()

  for (const p of paths) {
    const res = await fetch(`/api/files/raw?path=${encodeURIComponent(p)}`)
    if (!res.ok) throw new Error(`file failed: ${p} ${res.status}`)
    vfs.set(p, await res.text())
  }

  log(`VFS loaded: ${vfs.size} files`)
  return paths.length
}

/** Normalize to a VFS key: strip leading "./" and "/". */
function vfsKey(p) {
  return p.replace(/^\.\//, '').replace(/^\/+/, '')
}

function dirnameOf(p) {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/** Resolve a POSIX-ish path with . and .. segments. */
function joinPath(base, rel) {
  const parts = (base ? base.split('/') : []).concat(rel.split('/'))
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** Try a candidate path plus extension/index variants against the VFS. */
function resolveInVfs(candidate) {
  for (const ext of RESOLVE_EXTENSIONS) {
    const key = vfsKey(candidate + ext)
    if (vfs.has(key)) return key
  }
  for (const idx of RESOLVE_INDEX) {
    const key = vfsKey(candidate + idx)
    if (vfs.has(key)) return key
  }
  return null
}

/**
 * Resolve a bare specifier (`lodash`, `foo/bar`) against node_modules in the
 * VFS, honouring only the simple `module`/`main` fields.
 *
 * NOT exercised by the current fixture (it has zero runtime deps) and
 * deliberately shallow: no conditional `exports` maps, no CJS interop. Those
 * are the real work if this PoC is ever taken further — see README.
 */
function resolveBare(source) {
  const parts = source.split('/')
  const pkgName = source.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
  const subpath = source.slice(pkgName.length).replace(/^\//, '')
  const pkgDir = `node_modules/${pkgName}`

  if (subpath) return resolveInVfs(`${pkgDir}/${subpath}`)

  const manifestKey = `${pkgDir}/package.json`
  if (vfs.has(manifestKey)) {
    try {
      const pkg = JSON.parse(vfs.get(manifestKey))
      const field = pkg.module || pkg.main
      if (field) {
        const hit = resolveInVfs(joinPath(pkgDir, field))
        if (hit) return hit
      }
    } catch {
      // fall through to index lookup
    }
  }
  return resolveInVfs(pkgDir)
}

// ---------------------------------------------------------------------------
// The vite-like rollup plugin: VFS + esbuild-wasm transforms + CSS extraction
// ---------------------------------------------------------------------------

function vfsPlugin(collectedCss) {
  return {
    name: 'wc-exe-vfs',

    resolveId(source, importer) {
      // Entry (host passes a VFS-relative path).
      if (!importer) {
        const hit = resolveInVfs(source)
        if (!hit) throw new Error(`entry not found in VFS: ${source}`)
        return hit
      }

      if (source.startsWith('.') || source.startsWith('/')) {
        const base = source.startsWith('/') ? '' : dirnameOf(importer)
        const hit = resolveInVfs(joinPath(base, source))
        if (hit) return hit
        throw new Error(`cannot resolve "${source}" from "${importer}"`)
      }

      const bare = resolveBare(source)
      if (bare) return bare

      // Leave truly external specifiers alone rather than failing the build;
      // the emitted bundle would then rely on an import map at runtime.
      this.warn(`left external (not in VFS): ${source}`)
      return { id: source, external: true }
    },

    load(id) {
      if (!vfs.has(id)) return null
      return vfs.get(id)
    },

    async transform(code, id) {
      // CSS: collect it and leave an empty module behind, like vite's build
      // does when it extracts styles into a standalone asset.
      if (id.endsWith('.css')) {
        collectedCss.push(`/* ${id} */\n${code}`)
        return { code: 'export default ""', map: null }
      }

      const loader = id.match(/\.tsx$/)
        ? 'tsx'
        : id.match(/\.ts$|\.mts$/)
          ? 'ts'
          : id.match(/\.jsx$/)
            ? 'jsx'
            : null
      if (!loader) return null

      // The interception that matters: the project's TypeScript is transformed
      // by esbuild-wasm, never by a native esbuild binary.
      const out = await esbuild.transform(code, {
        loader,
        target: 'es2020',
        sourcefile: id,
      })
      return { code: out.code, map: null }
    },

    // Minify inside the rollup pipeline, which is where vite does it too (its
    // esbuild minifier runs as a renderChunk hook). Doing it here rather than
    // after generate() matters: rollup then hashes the *minified* output, so
    // asset filenames match what a real build would produce.
    async renderChunk(code) {
      const out = await esbuild.transform(code, {
        minify: true,
        target: 'es2020',
      })
      return { code: out.code, map: null }
    },
  }
}

// ---------------------------------------------------------------------------
// Entry discovery + HTML rewrite (what vite does for an index.html app)
// ---------------------------------------------------------------------------

function findHtmlEntry(html) {
  const m = html.match(
    /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/i
  )
  if (!m) throw new Error('no <script type="module" src="..."> in index.html')
  return vfsKey(m[1])
}

function rewriteHtml(html, jsFile, cssFile) {
  let out = html.replace(
    /<script[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    `<script type="module" crossorigin src="/${jsFile}"></script>`
  )
  if (cssFile) {
    out = out.replace(
      /<\/head>/i,
      `  <link rel="stylesheet" crossorigin href="/${cssFile}">\n  </head>`
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function runBuild() {
  const timings = {}
  const t0 = performance.now()

  await esbuild.initialize({ wasmURL: '/vendor/esbuild/esbuild.wasm' })
  timings.esbuildInitMs = Math.round(performance.now() - t0)
  log(`esbuild-wasm ready (${timings.esbuildInitMs}ms)`)

  const tVfs = performance.now()
  const fileCount = await loadProjectIntoVfs()
  timings.vfsLoadMs = Math.round(performance.now() - tVfs)

  const html = vfs.get('index.html')
  if (!html) throw new Error('index.html not found in VFS')
  const entry = findHtmlEntry(html)
  log(`entry from index.html: ${entry}`)

  // --- the measured burst: bundle + generate -------------------------------
  const tBuild = performance.now()
  const css = []
  const bundle = await rollup({
    input: entry,
    plugins: [vfsPlugin(css)],
    onwarn: (w) => log('rollup warn:', w.message),
  })

  // esbuild-wasm also handles CSS minification, matching vite's default.
  const cssJoined = css.join('\n')
  const cssSource = cssJoined.trim()
    ? (await esbuild.transform(cssJoined, { loader: 'css', minify: true })).code
    : ''
  const { output } = await bundle.generate({
    format: 'es',
    entryFileNames: 'assets/[name]-[hash].js',
    chunkFileNames: 'assets/[name]-[hash].js',
    assetFileNames: 'assets/[name]-[hash][extname]',
  })
  await bundle.close()
  timings.bundleMs = Math.round(performance.now() - tBuild)

  // Collect emitted files. CSS is appended by hand (rather than emitFile) so
  // the hashing stays visible and independent of rollup's asset pipeline.
  const files = []
  let jsEntryFile = null
  for (const chunk of output) {
    if (chunk.type === 'chunk') {
      files.push({ path: chunk.fileName, text: chunk.code })
      if (chunk.isEntry) jsEntryFile = chunk.fileName
    } else {
      const source =
        typeof chunk.source === 'string'
          ? chunk.source
          : new TextDecoder().decode(chunk.source)
      files.push({ path: chunk.fileName, text: source })
    }
  }
  if (!jsEntryFile) throw new Error('no entry chunk produced')

  let cssFile = null
  if (cssSource.trim()) {
    const hash = await sha8(cssSource)
    cssFile = `assets/style-${hash}.css`
    files.push({ path: cssFile, text: cssSource })
  }

  files.push({
    path: 'index.html',
    text: rewriteHtml(html, jsEntryFile, cssFile),
  })

  const tUpload = performance.now()
  for (const f of files) {
    const res = await fetch(`/api/dist?path=${encodeURIComponent(f.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode(f.text),
    })
    if (!res.ok) throw new Error(`upload failed: ${f.path} ${res.status}`)
  }
  timings.uploadMs = Math.round(performance.now() - tUpload)
  timings.totalMs = Math.round(performance.now() - t0)

  return {
    ok: true,
    fileCount,
    timings,
    outputs: files.map((f) => ({ path: f.path, bytes: f.text.length })),
  }
}

async function sha8(text) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  )
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

window.__pocBuild = async () => {
  try {
    const result = await runBuild()
    log('DONE', JSON.stringify(result.timings))
    return result
  } catch (err) {
    console.error('[poc] build failed:', err)
    return { ok: false, error: String(err?.stack || err) }
  }
}

window.__POC_READY__ = true
log('ready')
