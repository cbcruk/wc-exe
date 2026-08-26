// Browser-side production build via bundler interception.
//
// The thesis under test (docs/virtual-filesystem.md §2 layer C, §9): a
// production bundle can be produced entirely in a browser tab by swapping the
// native bundler binary for its browser build — rolldown ->
// @rolldown/browser — and feeding it a virtual filesystem instead of node:fs.
//
// This reimplements what `vite build` DOES for a vanilla app (discover the
// entry from index.html, transform TS, extract CSS, emit hashed assets,
// rewrite the HTML). It is NOT vite itself running — see README for why that
// distinction matters and what it does and does not prove.
//
// There used to be a second pipeline here (@rollup/browser + esbuild-wasm,
// matching vite 5–7). It is gone: under interception the *project's* vite
// version does not choose the bundler — we replace vite's pipeline rather than
// run it — so one bundler suffices, and rolldown is the one that handles CJS
// and can be handed a filesystem of its own. See README for the full
// accounting.

let lightningcss = null
/**
 * The loaded rolldown module. Kept because `--vfs=memfs` needs more than the
 * `rolldown` function off it: the prebundle re-exports the wasi binding's
 * memfs volume, and that volume IS the filesystem rolldown's native resolver
 * walks (see scripts/prebundle-rolldown.mjs).
 */
let rolldownModule = null

async function loadBundler(cssMinify) {
  const m = await import('/vendor/rolldown/rolldown.js')
  rolldownModule = m
  if (cssMinify) {
    // Warm lightningcss here, not at first use: its wasm init is ~0.6s and
    // would otherwise land inside the measured bundle burst.
    lightningcss = await import('/vendor/lightningcss/index.mjs')
    await lightningcss.default('/vendor/lightningcss/lightningcss_node.wasm')
  }
  return m.rolldown
}

/**
 * Minify CSS with lightningcss-wasm — the tool vite 8 uses (its deps are
 * rolldown, lightningcss and postcss), so this matches the toolchain the
 * intercepted bundler comes from.
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

/**
 * Runtime helper injected into the entry chunk — our equivalent of vite's
 * `__vitePreload`. Without it the browser cannot know a lazily-imported chunk's
 * own dependencies until it has fetched and parsed that chunk, so every level
 * of the graph costs another round trip.
 *
 * Deliberately simpler than vite's: no promise bookkeeping for in-flight CSS,
 * no error recovery, no base-URL handling beyond the root-absolute paths this
 * PoC emits.
 */
const PRELOAD_HELPER = `function __wcPreload(load, deps) {
  for (var i = 0; i < deps.length; i++) {
    var dep = deps[i];
    if (document.querySelector('link[href="' + dep + '"]')) continue;
    var link = document.createElement('link');
    link.rel = dep.endsWith('.css') ? 'stylesheet' : 'modulepreload';
    link.crossOrigin = '';
    link.href = dep;
    document.head.appendChild(link);
  }
  return load();
}
`

/**
 * Transitive static-import closure of a chunk, as root-absolute URLs, excluding
 * anything the entry already loads (those are in the document by then).
 */
function chunkPreloadDeps(bundle, target, alreadyLoaded) {
  const seen = new Set()
  const queue = [...(bundle[target]?.imports ?? [])]
  while (queue.length) {
    const next = queue.shift()
    if (seen.has(next) || alreadyLoaded.has(next)) continue
    seen.add(next)
    queue.push(...(bundle[next]?.imports ?? []))
  }
  return [...seen].map((f) => `/${f}`)
}

// ---------------------------------------------------------------------------
// Assets — what vite does with `import url from './logo.png'`
// ---------------------------------------------------------------------------
//
// The import becomes a URL string, and the file is emitted with a content hash
// — unless it is under `assetsInlineLimit` (4 KB by default), in which case it
// becomes a data URI and nothing is emitted. Ground truth from native
// `vite build` on `sample-asset-app`: a 111 B svg inlines as
// `data:image/svg+xml,…` and a 7,028 B png comes out as
// `assets/big-C1H63osM.png`.
//
// Without this the bundler tries to parse the file as JavaScript, which is why
// a stock `npm create vite` app failed with "stream did not contain valid
// UTF-8" and "Unexpected JSX expression in src/assets/react.svg".

const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
}

/** vite's default `assetsInlineLimit`. */
const ASSET_INLINE_LIMIT = 4096

const ASSET_VIRTUAL_PREFIX = 'virtual:wc-asset:'
// Same reason as the CSS suffix: rolldown picks a module type from the id's
// extension, so the id must end in something it will treat as JavaScript.
const ASSET_VIRTUAL_SUFFIX = '.js'

/** The extension of `p`, lowercased, including the dot. */
function extnameOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function isAssetPath(p) {
  const ext = extnameOf(p.split('?')[0])
  return ext !== '' && Object.hasOwn(ASSET_MIME_TYPES, ext)
}

/**
 * The `data:` URI vite would emit for a small asset.
 *
 * SVG goes in as text rather than base64 — that is what vite does, and it is
 * usually smaller. The escaping is not identical to vite's (which leaves `'`
 * and `=` unescaped); both are valid data URIs, and nothing here depends on
 * matching vite byte for byte.
 */
function assetDataUri(bytes, ext) {
  const mime = ASSET_MIME_TYPES[ext] ?? 'application/octet-stream'
  if (ext === '.svg') {
    return `data:${mime},${encodeURIComponent(new TextDecoder().decode(bytes))}`
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
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
// Preload hooks — shared by both VFS modes
// ---------------------------------------------------------------------------

/**
 * The `__wcPreload` wiring, as plugin hooks. Extracted because it is identical
 * whether the VFS reaches the bundler through plugin hooks or through
 * rolldown's own filesystem (see `--vfs=memfs`): it operates on the emitted
 * bundle, long after module contents stopped mattering.
 */
function preloadHooks(preload) {
  return {
    // rolldown never calls `renderDynamicImport` — vite's own two-phase trick
    // (emit a marker, resolve it once filenames are final) is unavailable, so
    // the wrapping happens here instead, rewriting the already-emitted
    // `import("./chunk.js")` calls. Filenames are final at this point, which is
    // also what makes the rehash below necessary.
    generateBundle(_options, bundle) {
      if (!preload) return
      const entry = Object.values(bundle).find(
        (c) => c.type === 'chunk' && c.isEntry
      )
      const entryLoads = new Set(entry?.imports ?? [])

      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue

        // oxc (rolldown's minifier) emits string literals as backtick
        // templates, hence the quote class.
        if (!chunk.dynamicImports?.length) continue
        let rewrote = false
        chunk.code = chunk.code.replace(
          /import\(\s*(["'`])(\.\/[^"'`]+\.js)\1\s*\)/g,
          (whole, _quote, spec) => {
            const target = chunk.dynamicImports.find(
              (t) => t.split('/').pop() === spec.split('/').pop()
            )
            if (!target) return whole
            const deps = chunkPreloadDeps(bundle, target, entryLoads)
            if (deps.length === 0) return whole
            rewrote = true
            return `__wcPreload(() => ${whole}, ${JSON.stringify(deps)})`
          }
        )
        if (rewrote) chunk.code = PRELOAD_HELPER + chunk.code
      }
    },
  }
}

// ---------------------------------------------------------------------------
// VFS mode A: feed the bundler through plugin hooks, with our own resolver
// ---------------------------------------------------------------------------
//
// rolldown transforms TypeScript and minifies itself (oxc), so this supplies
// only the VFS and the CSS extraction — plus the module resolution, which is
// the part `--vfs=memfs` exists to hand back (and which `sample-exports-app`
// shows this mode gets wrong on `browser` and `imports` fields).

function vfsPlugin(collectedCss, preload) {
  return {
    name: 'wc-exe-vfs',

    async resolveId(source, importer) {
      // Before anything else, because asset imports are usually relative and
      // would otherwise be resolved as ordinary modules and loaded as text —
      // producing a parse error that says nothing about assets. This mode
      // fetches file contents as text and has no way to emit binary output.
      if (importer && isAssetPath(source)) {
        throw new Error(
          `asset imports need --vfs=memfs: "${source}" from "${importer}"`
        )
      }

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

    transform(code) {
      // Dependencies branch on process.env.NODE_ENV (React picks its dev vs
      // production build that way). Nothing defines `process` in a browser, so
      // substitute it the way vite's `define` does. The memfs mode uses
      // rolldown's `define` option for the same job.
      if (!code.includes('process.env.NODE_ENV')) return null
      return {
        code: code.replace(/process\.env\.NODE_ENV/g, '"production"'),
        map: null,
      }
    },

    ...preloadHooks(preload),
  }
}

// ---------------------------------------------------------------------------
// VFS mode B: hand the files to rolldown's own filesystem (`--vfs=memfs`)
// ---------------------------------------------------------------------------
//
// The other mode feeds the bundler through `resolveId`/`load` and therefore has
// to answer "where does `react-dom/client` live?" itself — the conditional
// `exports` walker above. This mode instead writes the project into the memfs
// volume the wasi binding preopens at `/`, and lets **rolldown's own resolver**
// answer that question, exactly as it would against a real disk.
//
// This mode has two ways to fill that volume. `populateVolumeLazy` is the
// default and the one to read first; `populateVolume` below is the eager
// alternative it replaced, kept so the difference stays A/B-able. The eager one
// exists because "the bundler's fs calls are synchronous, so nothing can be
// fetched on demand" looked like a hard constraint. It is not — see
// installFaultIn.

/** Where the project is mounted inside the volume. */
const MEMFS_ROOT = '/project'

/**
 * Every project-relative path the volume knows about, in either fill mode.
 *
 * Needed because the volume itself cannot answer that question under the lazy
 * fill — a file that has not been faulted in is not there to be listed, so
 * `readdirSync` would quietly report an empty `public/`.
 */
const volumePaths = new Set()

/**
 * Everything under the project's `public/`, as project-relative paths.
 *
 * From the manifest rather than the volume, because under the lazy fill a file
 * nobody has read yet is not in the volume to be listed — and `public/` is
 * precisely the directory whose files the graph never touches.
 */
function publicFiles() {
  return [...volumePaths].filter((rel) => rel.startsWith('public/'))
}

/** Join `rel` onto an absolute directory, resolving `.` and `..`. */
function joinAbs(baseDir, rel) {
  const out = []
  for (const part of baseDir.split('/').concat(rel.split('/'))) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * Fill the volume from `/api/bulk`, which streams every project and dependency
 * file in one response.
 *
 * Eager alternative to the lazy fill, kept for A/B (`--eager`). One request
 * rather than one per file, because if the whole tree has to arrive then paying
 * a round trip per file would swamp the build it is meant to serve. The framing is
 * `u32 pathLen | path | u32 bodyLen | body`, repeated — binary so files that
 * are not UTF-8 (fonts, wasm, images inside packages) survive the trip.
 */
async function populateVolume(volume) {
  const tFetch = performance.now()
  const res = await fetch('/api/bulk')
  if (!res.ok) throw new Error(`bulk fetch failed: ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  const fetchMs = Math.round(performance.now() - tFetch)
  const tWrite = performance.now()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const decoder = new TextDecoder()
  const madeDirs = new Set()
  let off = 0
  let files = 0
  let bytes = 0

  while (off < buf.length) {
    const pathLen = view.getUint32(off)
    off += 4
    const rel = decoder.decode(buf.subarray(off, off + pathLen))
    off += pathLen
    const bodyLen = view.getUint32(off)
    off += 4
    const body = buf.subarray(off, off + bodyLen)
    off += bodyLen

    const full = `${MEMFS_ROOT}/${rel}`
    const dir = full.slice(0, full.lastIndexOf('/'))
    if (!madeDirs.has(dir)) {
      volume.mkdirSync(dir, { recursive: true })
      madeDirs.add(dir)
    }
    // slice(): the body is a view into the one big response buffer, and memfs
    // keeps whatever it is handed — without the copy every file would pin the
    // entire download.
    volume.writeFileSync(full, body.slice())
    volumePaths.add(rel)
    files++
    bytes += bodyLen
  }
  // Split because the two halves have different fixes: transfer responds to
  // compression, memfs writes do not.
  return {
    files,
    bytes,
    fetchMs,
    writeMs: Math.round(performance.now() - tWrite),
  }
}

/**
 * Fill the volume lazily instead: directories and a path manifest up front,
 * file contents only when the bundler actually opens one.
 *
 * The eager mode above exists because "the bundler's fs calls are synchronous,
 * so nothing can be fetched on demand" — which is true of `fetch`, and not true
 * of the page. A **synchronous XMLHttpRequest** still works, and the reason it
 * is a bad idea in a web app (it blocks the main thread) does not apply to a
 * headless build runner with no UI to block. Measured: 3 ms for a local
 * request, under COOP/COEP.
 *
 * Where to hook was decided by instrumenting rolldown rather than guessing. It
 * never calls `readFileSync`; it goes through the descriptor API —
 * `lstatSync`, `openSync`, `readSync`, `fstatSync`, `closeSync`,
 * `realpathSync` — against the page's own `memfs.fs` object. Both the page's
 * WASI and the wasi worker's fs-proxy land on that same object, so patching its
 * methods covers both.
 *
 * The fault-in triggers on ENOENT and never fabricates content: a path either
 * gets its real bytes or the original error. Directories are pre-created from
 * the manifest, because a missing directory has to report ENOENT truthfully for
 * resolution to work — only files are deferred.
 */
function installFaultIn(volume, fsObject, knownFiles, packageRoots, stats) {
  /** Write a `u32 pathLen | path | u32 bodyLen | body` stream into the volume. */
  const writeStream = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const decoder = new TextDecoder()
    let off = 0
    while (off < bytes.length) {
      const pathLen = view.getUint32(off)
      off += 4
      const rel = decoder.decode(bytes.subarray(off, off + pathLen))
      off += pathLen
      const bodyLen = view.getUint32(off)
      off += 4
      const body = bytes.subarray(off, off + bodyLen)
      off += bodyLen

      const full = `${MEMFS_ROOT}/${rel}`
      volume.mkdirSync(full.slice(0, full.lastIndexOf('/')), {
        recursive: true,
      })
      volume.writeFileSync(full, body.slice())
      volumePaths.add(rel)
      stats.loaded.add(rel)
      stats.files++
      stats.bytes += bodyLen
    }
  }

  /** Synchronous GET, binary-safe. See the note on `load` below. */
  const getBytes = (url) => {
    const req = new XMLHttpRequest()
    req.open('GET', url, false)
    // `responseType = 'arraybuffer'` is illegal on a synchronous main-thread
    // XHR. This is the standard way out: the charset makes every byte survive
    // as a code unit, and the low byte is the byte.
    req.overrideMimeType('text/plain; charset=x-user-defined')
    req.send(null)
    if (req.status !== 200) {
      // Kept rather than dropped: a package that could not be fetched shows up
      // downstream as "could not resolve react", which says nothing about why.
      stats.errors.push(`${url} -> ${req.status} ${req.responseText.trim()}`)
      return null
    }
    const text = req.responseText
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
    return out
  }

  /**
   * The package that owns `rel`, by longest matching install path. Longest
   * wins because the lockfile nests — `node_modules/a/node_modules/b` has to
   * beat `node_modules/a` for a file inside b.
   */
  const owningPackage = (rel) => {
    let best = null
    for (const root of packageRoots) {
      if (!rel.startsWith(`${root}/`)) continue
      if (!best || root.length > best.length) best = root
    }
    return best
  }

  /**
   * A miss inside a package the lockfile knows about pulls the **whole
   * package** — one request per package, not per file, because a registry
   * serves tarballs. Marked either way, so a genuinely absent path (resolution
   * probing `./x.ts`, `./x.tsx`, …) reports ENOENT instead of refetching.
   */
  const materialisePackage = (rel) => {
    const root = owningPackage(rel)
    if (!root || stats.packages.has(root)) return false
    stats.packages.add(root)
    const t0 = performance.now()
    const bytes = getBytes(`/api/package?path=${encodeURIComponent(root)}`)
    stats.ms += performance.now() - t0
    if (!bytes) return false
    writeStream(bytes)
    return true
  }

  const load = (abs) => {
    if (typeof abs !== 'string' || !abs.startsWith(`${MEMFS_ROOT}/`))
      return false
    const rel = abs.slice(MEMFS_ROOT.length + 1)
    if (stats.loaded.has(rel)) return false

    // Disk mode: the manifest already said this file exists, so fetch just it.
    if (knownFiles.has(rel)) {
      const t0 = performance.now()
      const bytes = getBytes(`/api/files/raw?path=${encodeURIComponent(rel)}`)
      stats.ms += performance.now() - t0
      if (!bytes) return false
      volume.writeFileSync(abs, bytes)
      stats.loaded.add(rel)
      stats.files++
      stats.bytes += bytes.length
      return true
    }

    // Registry mode: nothing knows a package's contents until its tarball is
    // unpacked, so pull the package and let the retry find the file.
    return materialisePackage(rel)
  }

  // `readFileSync` is in the list because the build reads some files directly
  // rather than through the bundler — CSS, assets, `public/` — and those can
  // live inside node_modules just as easily as in src.
  for (const name of [
    'lstatSync',
    'statSync',
    'openSync',
    'realpathSync',
    'readFileSync',
  ]) {
    const original = fsObject[name]
    if (typeof original !== 'function') continue
    fsObject[name] = function (target, ...rest) {
      try {
        return original.call(this, target, ...rest)
      } catch (err) {
        if (err?.code !== 'ENOENT' || !load(target)) throw err
        return original.call(this, target, ...rest)
      }
    }
  }
}

/**
 * Manifest + directories only. Source files are loaded eagerly (there are few
 * and the graph reaches all of them); dependency contents wait for a read.
 */
async function populateVolumeLazy(volume) {
  const t0 = performance.now()
  const [srcRes, depRes, pkgRes] = await Promise.all([
    fetch('/api/files'),
    fetch('/api/dep-files'),
    fetch('/api/packages'),
  ])
  if (!srcRes.ok) throw new Error(`manifest failed: ${srcRes.status}`)
  if (!depRes.ok) throw new Error(`dep manifest failed: ${depRes.status}`)
  if (!pkgRes.ok) throw new Error(`package list failed: ${pkgRes.status}`)
  const sourcePaths = await srcRes.json()
  const depPaths = await depRes.json()
  // Install paths from the lockfile — non-empty only in registry mode.
  const packageRoots = await pkgRes.json()

  const known = new Set([...sourcePaths, ...depPaths])
  for (const rel of known) volumePaths.add(rel)
  const dirs = new Set()
  for (const rel of known) {
    const full = `${MEMFS_ROOT}/${rel}`
    dirs.add(full.slice(0, full.lastIndexOf('/')))
  }
  // A package's own directory has to exist before resolution walks into it,
  // and the lockfile gives that without any network.
  for (const root of packageRoots) dirs.add(`${MEMFS_ROOT}/${root}`)
  for (const dir of dirs) volume.mkdirSync(dir, { recursive: true })

  const stats = {
    files: 0,
    bytes: 0,
    ms: 0,
    loaded: new Set(),
    packages: new Set(),
    errors: [],
  }
  installFaultIn(volume, rolldownModule.memfs.fs, known, packageRoots, stats)

  // Sources eagerly, in parallel — the fault-in path is serial by construction.
  await Promise.all(
    sourcePaths.map(async (rel) => {
      const res = await fetch(`/api/files/raw?path=${encodeURIComponent(rel)}`)
      if (!res.ok) throw new Error(`file failed: ${rel} ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      volume.writeFileSync(`${MEMFS_ROOT}/${rel}`, bytes)
      stats.loaded.add(rel)
      stats.files++
      stats.bytes += bytes.length
    })
  )

  return {
    stats,
    manifestMs: Math.round(performance.now() - t0),
    knownPaths: known.size,
    packageRoots: packageRoots.length,
    sourceCount: sourcePaths.length,
  }
}

/**
 * The only plugin this mode needs.
 *
 * rolldown refuses CSS input outright ("Bundling CSS is no longer supported"),
 * so stylesheets still have to be routed through a virtual module id — the same
 * dodge the other mode uses, and the same reason the id must not end in `.css`.
 * Everything else — resolution, TS, CJS interop, `exports` maps — is rolldown's
 * job here, which is the whole point of the mode.
 */
function memfsPlugin(collectedCss, collectedAssets, vfsFs, preload) {
  const absolutize = (source, importer) =>
    source.startsWith('/')
      ? source
      : joinAbs(dirnameOf(importer ?? `${MEMFS_ROOT}/index.html`), source)

  return {
    name: 'wc-exe-memfs-css-assets',

    resolveId(source, importer) {
      if (source.endsWith('.css')) {
        return (
          CSS_VIRTUAL_PREFIX + absolutize(source, importer) + CSS_VIRTUAL_SUFFIX
        )
      }
      if (isAssetPath(source)) {
        // Strip any `?query` — vite uses those for `?url`/`?raw`, which this
        // does not implement; the bare form is what resolves to a file.
        const abs = absolutize(source.split('?')[0], importer)
        return ASSET_VIRTUAL_PREFIX + abs + ASSET_VIRTUAL_SUFFIX
      }
      return null
    },

    async load(id) {
      if (id.startsWith(CSS_VIRTUAL_PREFIX)) {
        const key = id.slice(
          CSS_VIRTUAL_PREFIX.length,
          id.length - CSS_VIRTUAL_SUFFIX.length
        )
        collectedCss.push(`/* ${key} */\n${vfsFs.readFileSync(key, 'utf8')}`)
        return 'export default ""'
      }

      if (id.startsWith(ASSET_VIRTUAL_PREFIX)) {
        const key = id.slice(
          ASSET_VIRTUAL_PREFIX.length,
          id.length - ASSET_VIRTUAL_SUFFIX.length
        )
        const bytes = new Uint8Array(vfsFs.readFileSync(key))
        const ext = extnameOf(key)

        if (bytes.length <= ASSET_INLINE_LIMIT) {
          return `export default ${JSON.stringify(assetDataUri(bytes, ext))}`
        }

        // Hashed here rather than through the bundler's asset pipeline, and
        // hashed from the bytes themselves — so the name identifies the content
        // with no later rewrite to invalidate it, which is the mistake the
        // preload work already made once.
        const name = key.slice(
          key.lastIndexOf('/') + 1,
          key.length - ext.length
        )
        const path = `assets/${name}-${await sha8(bytes)}${ext}`
        if (!collectedAssets.some((a) => a.path === path)) {
          collectedAssets.push({ path, bytes })
        }
        return `export default ${JSON.stringify(`/${path}`)}`
      }

      return null
    },

    ...preloadHooks(preload),
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

/**
 * Stylesheets linked from the HTML rather than imported from a module.
 *
 * vite bundles those into the same CSS asset as the imported ones; this
 * pipeline only ever collected what the module graph reached, so a project
 * doing it this way shipped an HTML that still pointed at `./src/index.css` —
 * a 404 in the built output. The lit template does exactly that, and it is what
 * running the harness against outside projects turned up first.
 *
 * Returns project-relative paths; `data:` and absolute URLs are left alone.
 */
function htmlStylesheetLinks(html) {
  const out = []
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1]
    if (!href || /^(?:[a-z]+:|\/\/)/i.test(href)) continue
    out.push(vfsKey(href))
  }
  return out
}

function rewriteHtml(html, jsFile, cssFile) {
  let out = html.replace(
    /<script[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/i,
    `<script type="module" crossorigin src="/${jsFile}"></script>`
  )
  // Drop the source stylesheet links; their contents are in the emitted asset
  // now, and leaving them would point the built page at files that are not
  // there.
  out = out.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>\s*/gi, '')
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

async function runBuild(cssMinify, preload, vfsMode, lazy) {
  const timings = {}
  const t0 = performance.now()

  const bundleWith = await loadBundler(cssMinify)
  timings.toolInitMs = Math.round(performance.now() - t0)
  log(`rolldown toolchain ready (${timings.toolInitMs}ms)`)

  const memfsMode = vfsMode === 'memfs'
  const volume = memfsMode ? rolldownModule.memfs.volume : null

  // --- get the project in front of the bundler ------------------------------
  const tVfs = performance.now()
  let sourceCount = 0
  let depCount = 0
  let populated = null
  let html

  if (memfsMode && lazy) {
    const lazyInfo = await populateVolumeLazy(volume)
    populated = lazyInfo.stats
    sourceCount = lazyInfo.sourceCount
    html = volume.readFileSync(`${MEMFS_ROOT}/index.html`, 'utf8')
    log(
      `volume: ${lazyInfo.knownPaths} paths known` +
        (lazyInfo.packageRoots
          ? `, ${lazyInfo.packageRoots} packages from the lockfile`
          : '') +
        `, ${lazyInfo.sourceCount} source files loaded up front`
    )
  } else if (memfsMode) {
    populated = await populateVolume(volume)
    html = volume.readFileSync(`${MEMFS_ROOT}/index.html`, 'utf8')
    timings.volumeFetchMs = populated.fetchMs
    timings.volumeWriteMs = populated.writeMs
    log(
      `volume: ${populated.files} files, ` +
        `${(populated.bytes / 1048576).toFixed(1)} MB ` +
        `(fetch ${populated.fetchMs}ms + write ${populated.writeMs}ms)`
    )
  } else {
    ;({ sourceCount, depCount } = await loadManifests())
    html = vfs.get('index.html')
  }
  timings.manifestMs = Math.round(performance.now() - tVfs)

  if (!html) throw new Error('index.html not found in VFS')
  const entry = findHtmlEntry(html)
  log(`entry from index.html: ${entry}`)

  // Stylesheets the HTML links directly never enter the module graph, so
  // collect them before the build rather than during it.
  const htmlCss = []
  if (memfsMode) {
    const vfsFs = rolldownModule.memfs.fs
    for (const rel of htmlStylesheetLinks(html)) {
      try {
        htmlCss.push(
          `/* ${rel} */\n${vfsFs.readFileSync(`${MEMFS_ROOT}/${rel}`, 'utf8')}`
        )
      } catch {
        log(`html stylesheet not found, skipped: ${rel}`)
      }
    }
  }

  // --- the measured burst: bundle + generate -------------------------------
  const tBuild = performance.now()
  const css = []
  const assets = []
  const unresolved = []
  const bundle = await bundleWith({
    input: memfsMode ? `${MEMFS_ROOT}/${entry}` : entry,
    plugins: memfsMode
      ? [memfsPlugin(css, assets, rolldownModule.memfs.fs, preload)]
      : [vfsPlugin(css, preload)],
    onwarn: (w) => {
      log('bundler warn:', w.message ?? w)
      // rolldown treats an unresolvable bare specifier as external and carries
      // on. For a browser bundle with no import map that is never right: the
      // build "succeeds" and the page dies on `Failed to resolve module
      // specifier`. Collected here and thrown after generate, so the message
      // lists every one rather than only the first.
      if (w.code === 'UNRESOLVED_IMPORT')
        unresolved.push(w.message ?? String(w))
    },
    ...(memfsMode
      ? {
          cwd: MEMFS_ROOT,
          // Pick `browser` over `node` in conditional exports — the hand-rolled
          // resolver's EXPORT_CONDITIONS order, expressed as rolldown's own
          // option instead of reimplemented.
          platform: 'browser',
          // React and friends branch on this to pick their dev vs production
          // build, and a page has no `process`. The other mode substitutes it
          // in a transform hook; here it is what vite's `define` does.
          define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        }
      : {}),
  })

  const { output } = await bundle.generate({
    format: 'es',
    entryFileNames: 'assets/[name]-[hash].js',
    chunkFileNames: 'assets/[name]-[hash].js',
    assetFileNames: 'assets/[name]-[hash][extname]',
    // rolldown minifies through an output option rather than a renderChunk
    // hook, so the hash is computed over the minified bytes — which is what a
    // real build does too.
    minify: true,
  })
  await bundle.close()

  // Read the collected CSS only now: rolldown defers module loading until
  // generate(), so reading any earlier silently produces no stylesheet.
  const cssJoined = [...htmlCss, ...css].join('\n')
  let cssSource = ''
  if (cssJoined.trim()) {
    cssSource = lightningcss ? minifyCssWithLightning(cssJoined) : cssJoined
  }
  if (unresolved.length) {
    // Fetch failures are the usual cause in registry mode, and they explain
    // *why* far better than the resolution message does.
    const why = populated?.errors?.length
      ? `\n\ncould not fetch:\n  ${populated.errors.join('\n  ')}`
      : ''
    throw new Error(
      `${unresolved.length} import(s) could not be resolved and would have ` +
        `been left external — a browser bundle has no import map, so that is ` +
        `a build that fails at runtime:\n  ${unresolved.slice(0, 5).join('\n  ')}${why}`
    )
  }

  timings.bundleMs = Math.round(performance.now() - tBuild)

  if (memfsMode && lazy) {
    // Only knowable now: the manifest said what exists, the graph said what
    // mattered. That gap is the whole argument for this mode.
    timings.faultInMs = Math.round(populated.ms)
    log(
      `faulted in ${populated.files} files` +
        (populated.packages.size
          ? ` from ${populated.packages.size} packages`
          : '') +
        `, ${(populated.bytes / 1048576).toFixed(1)} MB ` +
        `(${timings.faultInMs}ms of blocking XHR)`
    )
  }

  // Collect emitted files. CSS is appended by hand (rather than emitFile) so
  // the hashing stays visible and independent of the bundler's asset pipeline.
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

  // Rehash anything generateBundle rewrote. The preload wiring mutates chunk
  // code after the bundler has hashed it, so without this a chunk's name no
  // longer identifies its bytes. Concretely, building with and without preload
  // produced the same filename holding different content, which is a
  // cache-poisoning bug.
  //
  // vite avoids the problem differently, using the bundler's hash placeholders
  // so the final content is hashed in the first place. Renaming afterwards is
  // the equivalent outcome for a post-processing pipeline like this one.
  const renamed = new Map()
  for (const f of files) {
    if (!f.path.endsWith('.js') || typeof f.text !== 'string') continue
    if (!f.text.includes('function __wcPreload')) continue
    const hash = await sha8(f.text)
    const next = f.path.replace(/-[^-.]+\.js$/, `-${hash}.js`)
    if (next !== f.path) renamed.set(f.path, next)
  }

  if (renamed.size) {
    // Renaming a chunk that another chunk imports by name would need the
    // rename to cascade through those importers (and rehash them in turn).
    // Nothing in the fixtures hits that, so refuse rather than emit output
    // whose references silently dangle.
    for (const [oldPath] of renamed) {
      const base = oldPath.split('/').pop()
      for (const other of files) {
        if (other.path === oldPath || !other.path.endsWith('.js')) continue
        if (other.text.includes(base)) {
          throw new Error(
            `rehash would break a reference: ${other.path} imports ${base}`
          )
        }
      }
    }

    for (const f of files) {
      const next = renamed.get(f.path)
      if (next) f.path = next
    }
    if (renamed.has(jsEntryFile)) jsEntryFile = renamed.get(jsEntryFile)
    log(`rehashed ${renamed.size} rewritten chunk(s)`)
  }

  let cssFile = null
  if (cssSource.trim()) {
    const hash = await sha8(cssSource)
    cssFile = `assets/style-${hash}.css`
    files.push({ path: cssFile, text: cssSource })
  }

  // Assets the graph referenced and that were over the inline limit. They are
  // already named by their content hash, so nothing downstream renames them.
  for (const asset of assets)
    files.push({ path: asset.path, bytes: asset.bytes })

  // `public/` is copied verbatim to the output root — no hashing, no graph
  // involvement. It is how vite ships files referenced by a literal URL
  // (`<use href="/icons.svg">`), which the bundler never sees and so can never
  // emit. Without this a stock vite template 404s at runtime while building
  // cleanly.
  if (memfsMode) {
    const vfsFs = rolldownModule.memfs.fs
    for (const rel of publicFiles()) {
      files.push({
        path: rel.slice('public/'.length),
        bytes: new Uint8Array(vfsFs.readFileSync(`${MEMFS_ROOT}/${rel}`)),
      })
    }
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
      body: f.bytes ?? new TextEncoder().encode(f.text),
    })
    if (!res.ok) throw new Error(`upload failed: ${f.path} ${res.status}`)
  }
  timings.uploadMs = Math.round(performance.now() - tUpload)
  timings.totalMs = Math.round(performance.now() - t0)

  return {
    ok: true,
    sourceCount,
    depCount,
    // In memfs mode nothing is read lazily, so "how many dependency files did
    // the graph actually touch" has no answer — the whole tree was resident
    // before the build began. Report what that cost instead.
    depFilesRead: memfsMode
      ? null
      : [...vfs.keys()].filter((k) => k.startsWith('node_modules/')).length,
    volumeFiles: populated?.files ?? null,
    volumeBytes: populated?.bytes ?? null,
    // Lazy mode: how much of the manifest the graph actually touched.
    faultedInFiles: populated?.loaded ? populated.files : null,
    timings,
    outputs: files.map((f) => ({
      path: f.path,
      bytes: f.bytes ? f.bytes.length : f.text.length,
    })),
  }
}

async function sha8(input) {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

window.__pocBuild = async (options = {}) => {
  const cssMinify = options.cssMinify !== false
  const preload = options.preload !== false
  const vfsMode = options.vfs === 'memfs' ? 'memfs' : 'plugin'
  // Lazy unless the host asked for the eager fill.
  const lazy = options.lazy !== false
  try {
    const result = await runBuild(cssMinify, preload, vfsMode, lazy)
    result.vfs = vfsMode + (vfsMode === 'memfs' && !lazy ? '+eager' : '')
    log('DONE', JSON.stringify(result.timings))
    return result
  } catch (err) {
    console.error('[poc] build failed:', err)
    return { ok: false, error: String(err?.stack || err) }
  }
}

window.__POC_READY__ = true
log('ready')
