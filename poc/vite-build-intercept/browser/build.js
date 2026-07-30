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

// Bundlers are imported dynamically so only the selected one is fetched:
//   rollup   = vite 5's pipeline  (@rollup/browser + esbuild-wasm)
//   rolldown = vite 8's pipeline  (@rolldown/browser alone — it transforms TS
//              and minifies itself via oxc, so esbuild is not needed)
let esbuild = null
let lightningcss = null

async function loadBundler(kind, cssMinify) {
  if (kind === 'rolldown') {
    const m = await import('/vendor/rolldown/rolldown.js')
    if (cssMinify) {
      // Warm lightningcss here, not at first use: its wasm init is ~0.6s and
      // would otherwise land inside the measured bundle burst.
      lightningcss = await import('/vendor/lightningcss/index.mjs')
      await lightningcss.default('/vendor/lightningcss/lightningcss_node.wasm')
    }
    return m.rolldown
  }
  const m = await import('/vendor/rollup/rollup.browser.js')
  esbuild = await import('/vendor/esbuild/esm/browser.min.js')
  return m.rollup
}

/**
 * Minify CSS with lightningcss-wasm — the tool vite 8 uses (its deps are
 * rolldown, lightningcss and postcss). Only the rolldown path loads it; the
 * rollup path minifies CSS with esbuild, matching vite 5.
 *
 * The module is initialized during toolchain setup (see loadBundler). Its wasm
 * resolves relative to the module URL, so serving the package directory is
 * enough; `napi-wasm` comes from the page's import map.
 */
function minifyCssWithLightning(cssText) {
  const { code } = lightningcss.transform({
    filename: 'style.css',
    code: new TextEncoder().encode(cssText),
    minify: true,
  })
  return new TextDecoder().decode(code)
}

// CSS is routed through a virtual module id so the bundler never sees a `.css`
// extension. rolldown hard-refuses CSS input ("Bundling CSS is no longer
// supported"), and vite's own build extracts styles rather than bundling them,
// so this both fixes rolldown and matches what vite does.
const CSS_VIRTUAL_PREFIX = 'virtual:wc-css:'
// The virtual id must not *end* in `.css` either — rolldown picks a module type
// from the id's suffix, so a trailing `.js` is what makes it treat this as JS.
const CSS_VIRTUAL_SUFFIX = '.js'

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']
const RESOLVE_INDEX = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs']

/** Loaded file contents: VFS path (no leading slash) -> text. */
const vfs = new Map()

/**
 * Every path that exists, including node_modules. Kept separate from `vfs` so
 * resolution stays synchronous while contents load lazily: a React app's
 * node_modules is thousands of files but only a few dozen end up in the graph,
 * so fetching all of them up front would dominate the build.
 */
const knownPaths = new Set()

function log(...args) {
  console.log('[poc]', ...args)
}

// ---------------------------------------------------------------------------
// VFS — eager manifest, lazy contents
// ---------------------------------------------------------------------------

async function loadManifests() {
  const [srcRes, depRes] = await Promise.all([
    fetch('/api/files'),
    fetch('/api/dep-files'),
  ])
  if (!srcRes.ok) throw new Error(`manifest failed: ${srcRes.status}`)
  if (!depRes.ok) throw new Error(`dep manifest failed: ${depRes.status}`)

  const srcPaths = await srcRes.json()
  const depPaths = await depRes.json()
  for (const p of [...srcPaths, ...depPaths]) knownPaths.add(p)

  // Project sources are few and all get read, so fetch them eagerly.
  await Promise.all(srcPaths.map((p) => loadFile(p)))

  log(`manifest: ${srcPaths.length} source + ${depPaths.length} dep files`)
  return { sourceCount: srcPaths.length, depCount: depPaths.length }
}

async function loadFile(p) {
  const cached = vfs.get(p)
  if (cached !== undefined) return cached
  const res = await fetch(`/api/files/raw?path=${encodeURIComponent(p)}`)
  if (!res.ok) throw new Error(`file failed: ${p} ${res.status}`)
  const text = await res.text()
  vfs.set(p, text)
  return text
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

/** Try a candidate path plus extension/index variants against known paths. */
function resolveInVfs(candidate) {
  for (const ext of RESOLVE_EXTENSIONS) {
    const key = vfsKey(candidate + ext)
    if (knownPaths.has(key)) return key
  }
  for (const idx of RESOLVE_INDEX) {
    const key = vfsKey(candidate + idx)
    if (knownPaths.has(key)) return key
  }
  return null
}

/**
 * Conditions we honour when walking an `exports` map, most specific first.
 * A browser build wants `browser` over `node`, and ESM over CJS.
 */
const EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default', 'require']

/**
 * Pick a target out of an `exports` entry, which may be a bare string or a
 * nested condition object. Returns null when nothing applies (e.g. a
 * `node`-only branch).
 */
function pickCondition(entry) {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return null
  if (Array.isArray(entry)) {
    for (const alt of entry) {
      const hit = pickCondition(alt)
      if (hit) return hit
    }
    return null
  }
  for (const cond of EXPORT_CONDITIONS) {
    if (cond in entry) {
      const hit = pickCondition(entry[cond])
      if (hit) return hit
    }
  }
  return null
}

/**
 * Resolve `subpath` ('' for the package root) against an `exports` map,
 * supporting exact keys and a single trailing `*` pattern.
 */
function resolveExports(exportsField, subpath) {
  const key = subpath ? `./${subpath}` : '.'

  // A string or condition object directly under "exports" only defines ".".
  if (
    typeof exportsField === 'string' ||
    Array.isArray(exportsField) ||
    (exportsField &&
      typeof exportsField === 'object' &&
      !Object.keys(exportsField).some((k) => k === '.' || k.startsWith('./')))
  ) {
    return key === '.' ? pickCondition(exportsField) : null
  }

  if (key in exportsField) return pickCondition(exportsField[key])

  for (const [pattern, entry] of Object.entries(exportsField)) {
    if (!pattern.includes('*')) continue
    const [head, tail] = pattern.split('*')
    if (key.startsWith(head) && key.endsWith(tail)) {
      const star = key.slice(head.length, key.length - (tail.length || 0))
      const target = pickCondition(entry)
      if (target) return target.replace('*', star)
    }
  }
  return null
}

/**
 * Resolve a bare specifier (`react`, `react-dom/client`) against node_modules,
 * honouring conditional `exports` maps first and falling back to the legacy
 * `module`/`main` fields.
 *
 * Async because the package manifest itself is fetched lazily.
 */
async function resolveBare(source) {
  const parts = source.split('/')
  const pkgName = source.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
  const subpath = source.slice(pkgName.length).replace(/^\//, '')
  const pkgDir = `node_modules/${pkgName}`
  const manifestKey = `${pkgDir}/package.json`

  if (knownPaths.has(manifestKey)) {
    let pkg = null
    try {
      pkg = JSON.parse(await loadFile(manifestKey))
    } catch {
      pkg = null
    }

    if (pkg?.exports) {
      const target = resolveExports(pkg.exports, subpath)
      if (target) {
        const hit = resolveInVfs(joinPath(pkgDir, target))
        if (hit) return hit
      }
    }

    if (!subpath) {
      const field = pkg?.module || pkg?.main
      if (field) {
        const hit = resolveInVfs(joinPath(pkgDir, field))
        if (hit) return hit
      }
    }
  }

  if (subpath) return resolveInVfs(`${pkgDir}/${subpath}`)
  return resolveInVfs(pkgDir)
}

// ---------------------------------------------------------------------------
// The vite-like rollup plugin: VFS + esbuild-wasm transforms + CSS extraction
// ---------------------------------------------------------------------------

function vfsPlugin(collectedCss, kind) {
  // rolldown transforms TypeScript and minifies itself (oxc); with it we only
  // supply the VFS and the CSS extraction. With rollup we must also drive
  // esbuild-wasm for both jobs.
  const needsEsbuild = kind !== 'rolldown'

  return {
    name: 'wc-exe-vfs',

    async resolveId(source, importer) {
      // Entry (host passes a VFS-relative path).
      if (!importer) {
        const hit = resolveInVfs(source)
        if (!hit) throw new Error(`entry not found in VFS: ${source}`)
        return hit
      }

      if (source.startsWith('.') || source.startsWith('/')) {
        const base = source.startsWith('/') ? '' : dirnameOf(importer)
        const hit = resolveInVfs(joinPath(base, source))
        if (hit) {
          return hit.endsWith('.css')
            ? CSS_VIRTUAL_PREFIX + hit + CSS_VIRTUAL_SUFFIX
            : hit
        }
        throw new Error(`cannot resolve "${source}" from "${importer}"`)
      }

      const bare = await resolveBare(source)
      if (bare) return bare

      // Leave truly external specifiers alone rather than failing the build;
      // the emitted bundle would then rely on an import map at runtime.
      this.warn(`left external (not in VFS): ${source}`)
      return { id: source, external: true }
    },

    async load(id) {
      if (id.startsWith(CSS_VIRTUAL_PREFIX)) {
        const key = id
          .slice(CSS_VIRTUAL_PREFIX.length)
          .slice(0, -CSS_VIRTUAL_SUFFIX.length)
        collectedCss.push(`/* ${key} */\n${await loadFile(key)}`)
        return 'export default ""'
      }
      if (!knownPaths.has(id)) return null
      return loadFile(id)
    },

    async transform(code, id) {
      // Dependencies branch on process.env.NODE_ENV (React picks its dev vs
      // production build that way). Nothing defines `process` in a browser, so
      // substitute it the way vite's `define` does.
      let source = code
      if (source.includes('process.env.NODE_ENV')) {
        source = source.replace(/process\.env\.NODE_ENV/g, '"production"')
      }

      if (!needsEsbuild)
        return source === code ? null : { code: source, map: null }

      const loader = id.match(/\.tsx$/)
        ? 'tsx'
        : id.match(/\.ts$|\.mts$/)
          ? 'ts'
          : id.match(/\.jsx$/)
            ? 'jsx'
            : null
      if (!loader) return source === code ? null : { code: source, map: null }

      // The interception that matters: the project's TypeScript/JSX is
      // transformed by esbuild-wasm, never by a native esbuild binary.
      const out = await esbuild.transform(source, {
        loader,
        target: 'es2020',
        sourcefile: id,
        jsx: 'automatic',
      })
      return { code: out.code, map: null }
    },

    // Minify inside the rollup pipeline, which is where vite does it too (its
    // esbuild minifier runs as a renderChunk hook). Doing it here rather than
    // after generate() matters: rollup then hashes the *minified* output, so
    // asset filenames match what a real build would produce.
    async renderChunk(code) {
      if (!needsEsbuild) return null // rolldown minifies via its output option
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

async function runBuild(kind, cssMinify) {
  const timings = {}
  const t0 = performance.now()

  const bundleWith = await loadBundler(kind, cssMinify)
  if (esbuild) {
    await esbuild.initialize({ wasmURL: '/vendor/esbuild/esbuild.wasm' })
  }
  timings.toolInitMs = Math.round(performance.now() - t0)
  log(`${kind} toolchain ready (${timings.toolInitMs}ms)`)

  const tVfs = performance.now()
  const { sourceCount, depCount } = await loadManifests()
  timings.manifestMs = Math.round(performance.now() - tVfs)

  const html = vfs.get('index.html')
  if (!html) throw new Error('index.html not found in VFS')
  const entry = findHtmlEntry(html)
  log(`entry from index.html: ${entry}`)

  // --- the measured burst: bundle + generate -------------------------------
  const tBuild = performance.now()
  const css = []
  const bundle = await bundleWith({
    input: entry,
    plugins: [vfsPlugin(css, kind)],
    onwarn: (w) => log('bundler warn:', w.message ?? w),
  })

  const outputOptions = {
    format: 'es',
    entryFileNames: 'assets/[name]-[hash].js',
    chunkFileNames: 'assets/[name]-[hash].js',
    assetFileNames: 'assets/[name]-[hash][extname]',
  }
  // rolldown minifies through an output option rather than a renderChunk hook.
  if (kind === 'rolldown') outputOptions.minify = true

  const { output } = await bundle.generate(outputOptions)
  await bundle.close()

  // Read the collected CSS only now: rollup populates it during rollup(), but
  // rolldown defers module loading until generate(), so reading any earlier
  // silently produces no stylesheet.
  const cssJoined = css.join('\n')
  let cssSource = ''
  if (cssJoined.trim()) {
    // Each pipeline minifies CSS with the tool its vite era uses: vite 5 →
    // esbuild, vite 8 → lightningcss.
    cssSource = esbuild
      ? (await esbuild.transform(cssJoined, { loader: 'css', minify: true }))
          .code
      : lightningcss
        ? minifyCssWithLightning(cssJoined)
        : cssJoined
  }
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
    sourceCount,
    depCount,
    depFilesRead: [...vfs.keys()].filter((k) => k.startsWith('node_modules/'))
      .length,
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

window.__pocBuild = async (options = {}) => {
  const kind = options.bundler === 'rolldown' ? 'rolldown' : 'rollup'
  const cssMinify = options.cssMinify !== false
  try {
    const result = await runBuild(kind, cssMinify)
    result.bundler = kind
    log('DONE', JSON.stringify(result.timings))
    return result
  } catch (err) {
    console.error('[poc] build failed:', err)
    return { ok: false, error: String(err?.stack || err) }
  }
}

window.__POC_READY__ = true
log('ready')
