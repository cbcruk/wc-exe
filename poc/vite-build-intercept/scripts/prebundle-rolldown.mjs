// Pre-bundle @rolldown/browser into a single browser-loadable ESM file.
//
// Why this step exists (a real finding of the PoC): unlike @rollup/browser,
// which a page can `import` as shipped, @rolldown/browser's browser entry still
// statically imports `node:fs` and `node:url`, and its wasi binding pulls in
// `@napi-rs/wasm-runtime` -> `@tybys/wasm-util` -> `@emnapi/*` as bare
// specifiers. Raw ESM in a page cannot resolve that chain, so the bundler has
// to be bundled first, with the node builtins pointed at browser stubs.
//
// The emitted file keeps fetching `./rolldown-binding.wasm32-wasi.wasm`
// relative to its own URL, so the wasm is copied next to it and both are served
// as siblings under /vendor/rolldown/.
//
// It also prepares the bundle for `--vfs=memfs` (see browser/build.js) by
// re-exporting the binding's memfs volume, so the page can populate the
// filesystem rolldown's own resolver walks. That is a no-op for the plugin-fed
// VFS path, so one vendored bundle serves both.
//
//   node poc/vite-build-intercept/scripts/prebundle-rolldown.mjs
//   node poc/vite-build-intercept/scripts/prebundle-rolldown.mjs --fs-payload-bytes=10485760

import * as esbuild from 'esbuild-wasm'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT_DIR = path.join(ROOT, 'vendor/rolldown')
const ROLLDOWN_DIST = path.join(ROOT, 'node_modules/@rolldown/browser/dist')

/**
 * Optional override for the worker->page fs-proxy payload cap, in bytes.
 * `null` (the default) leaves `@napi-rs/wasm-runtime` untouched.
 *
 * How the proxy works: the wasi worker allocates a `SharedArrayBuffer` per fs
 * call, blocks on `Atomics.wait`, and the page writes that call's return value
 * into it. `@napi-rs/wasm-runtime` sizes the buffer at **10 KB**.
 *
 * vrowzer raises this to ~10 MB, and going in it looked mandatory — react-dom
 * is ~130 KB, so if module *contents* crossed the proxy every dependency read
 * would blow the cap. **Measured, they do not.** With `--vfs=memfs` the React
 * fixture builds byte-identically at the stock 10 KB, and still does at 1 KB;
 * contents are read on the page's own WASI, not through the worker. Bisecting
 * puts what actually crosses between 256 B and 1 KB — path strings and stat
 * results.
 *
 * So the patch is **not applied by default**: patching a dependency's source to
 * buy nothing is pure liability. The flag stays only because the failure mode
 * is nasty enough to want a one-line escape hatch — see below.
 *
 *   node scripts/prebundle-rolldown.mjs --fs-payload-bytes=10485760
 */
const FS_PAYLOAD_BYTES = process.argv.some((a) =>
  a.startsWith('--fs-payload-bytes=')
)
  ? Math.floor(
      Number(
        process.argv
          .find((a) => a.startsWith('--fs-payload-bytes='))
          .split('=')[1]
      )
    )
  : null

/**
 * Rewrite that cap.
 *
 * **Overflow does not raise.** Bisecting the cap downward, a build that no
 * longer fits never reports `RangeError: payload overflow`: at 256 B the
 * renderer dies outright ("Target closed"), at 64 B the page simply hangs. A
 * project that did overflow would present as a crash or a stall with nothing
 * pointing here — which is why the knob is kept even though nothing needs it.
 *
 * A string patch on a dependency's source is a liability either way, so it
 * fails loudly rather than quietly emitting an unpatched bundle.
 */
const expandFsProxyBuffer = {
  name: 'expand-fs-proxy-buffer',
  setup(build) {
    const NEEDLE = 'const RESPONSE_PAYLOAD_SIZE = 10240'
    let patched = false

    build.onLoad(
      { filter: /[\\/]wasm-runtime[\\/]fs-proxy\.js$/ },
      async (args) => {
        const source = await fs.readFile(args.path, 'utf8')
        if (!source.includes(NEEDLE)) {
          return {
            errors: [
              {
                text:
                  `${args.path} no longer contains "${NEEDLE}". ` +
                  `@napi-rs/wasm-runtime changed its fs-proxy; re-derive the patch.`,
              },
            ],
          }
        }
        patched = true
        return {
          contents: source.replace(
            NEEDLE,
            `const RESPONSE_PAYLOAD_SIZE = ${FS_PAYLOAD_BYTES}`
          ),
          loader: 'js',
        }
      }
    )

    // The plugin is silent if the file is never resolved at all — which would
    // also leave the cap at 10 KB.
    build.onEnd((result) => {
      if (!patched && result.errors.length === 0) {
        result.errors.push({
          text:
            'fs-proxy.js was never loaded, so the payload cap was not raised. ' +
            'Check that @napi-rs/wasm-runtime still ships it as its own module.',
        })
      }
    })
  },
}

/**
 * Both sides must agree on the number — the worker sizes the buffer with it and
 * the page range-checks against it — so the patch goes into both bundles or
 * into neither.
 */
const fsProxyPlugins = FS_PAYLOAD_BYTES === null ? [] : [expandFsProxyBuffer]

/** Point the node builtins rolldown still imports at the page's browser stubs. */
const shimNodeBuiltins = {
  name: 'shim-node-builtins',
  setup(build) {
    const shims = {
      'node:fs': path.join(ROOT, 'browser/shim/node-fs.js'),
      'node:url': path.join(ROOT, 'browser/shim/node-url.js'),
    }
    build.onResolve({ filter: /^node:/ }, (args) => {
      const shim = shims[args.path]
      if (shim) return { path: shim }
      // Anything else would be a genuinely new requirement — fail loudly rather
      // than silently emitting a broken bundle.
      return {
        errors: [
          {
            text:
              `@rolldown/browser needs an unshimmed node builtin: ${args.path}. ` +
              `Add a stub under browser/shim/ and map it here.`,
          },
        ],
      }
    })
  },
}

async function main() {
  await esbuild.initialize({})

  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })

  const result = await esbuild.build({
    stdin: {
      // `memfs` comes from the experimental entry and is the *same* volume the
      // wasi binding preopens at `/` — esbuild bundles the binding once, so the
      // page and rolldown's native resolver see one filesystem, not two copies.
      contents:
        `export * from '@rolldown/browser'\n` +
        `export { memfs } from '@rolldown/browser/experimental'\n`,
      resolveDir: ROOT,
      sourcefile: 'rolldown-browser-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // Take the package's "browser" export condition, not the node one.
    conditions: ['browser', 'import', 'default'],
    mainFields: ['browser', 'module', 'main'],
    // The wasi binding uses top-level await to initialize the wasm module.
    target: 'es2022',
    plugins: [shimNodeBuiltins, ...fsProxyPlugins],
    // rolldown's option normalizer reads `process`; give it the minimum.
    banner: {
      js:
        'globalThis.process ??= { env: {}, platform: "browser", ' +
        'cwd: () => "/", argv: [], versions: {} };',
    },
    write: false,
    logLevel: 'warning',
  })

  const [file] = result.outputFiles
  await fs.writeFile(path.join(OUT_DIR, 'rolldown.js'), file.contents)

  // The wasi binding spawns a worker via
  // `new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url))`, and
  // that worker imports @napi-rs/wasm-runtime as a bare specifier. Workers do
  // NOT inherit the page's import map, so the worker has to be bundled too —
  // and must keep its exact filename so the relative URL still resolves.
  const worker = await esbuild.build({
    entryPoints: [path.join(ROLLDOWN_DIST, 'wasi-worker-browser.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['browser', 'import', 'default'],
    mainFields: ['browser', 'module', 'main'],
    target: 'es2022',
    plugins: [shimNodeBuiltins, ...fsProxyPlugins],
    write: false,
    logLevel: 'warning',
  })
  await fs.writeFile(
    path.join(OUT_DIR, 'wasi-worker-browser.mjs'),
    worker.outputFiles[0].contents
  )

  // The binding fetches its wasm relative to its own module URL.
  const wasmName = 'rolldown-binding.wasm32-wasi.wasm'
  await fs.copyFile(
    path.join(ROLLDOWN_DIST, wasmName),
    path.join(OUT_DIR, wasmName)
  )

  const workerSize = (
    await fs.stat(path.join(OUT_DIR, 'wasi-worker-browser.mjs'))
  ).size
  const js = (await fs.stat(path.join(OUT_DIR, 'rolldown.js'))).size
  const wasm = (await fs.stat(path.join(OUT_DIR, wasmName))).size
  console.log(`prebundled @rolldown/browser -> vendor/rolldown/`)
  console.log(`  rolldown.js  ${(js / 1024).toFixed(0)} KB`)
  console.log(`  wasi-worker-browser.mjs  ${(workerSize / 1024).toFixed(0)} KB`)
  console.log(`  ${wasmName}  ${(wasm / 1048576).toFixed(1)} MB`)
  console.log(
    `  fs-proxy payload cap  ${
      FS_PAYLOAD_BYTES === null
        ? 'stock 10240 B (@napi-rs/wasm-runtime unpatched)'
        : `${FS_PAYLOAD_BYTES} B (patched; stock is 10240 B)`
    }`
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('prebundle failed:', err.message)
  process.exit(1)
})
