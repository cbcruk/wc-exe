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
//   node poc/vite-build-intercept/scripts/prebundle-rolldown.mjs

import * as esbuild from 'esbuild-wasm'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT_DIR = path.join(ROOT, 'vendor/rolldown')
const ROLLDOWN_DIST = path.join(ROOT, 'node_modules/@rolldown/browser/dist')

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
      contents: `export * from '@rolldown/browser'`,
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
    plugins: [shimNodeBuiltins],
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
    plugins: [shimNodeBuiltins],
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
  process.exit(0)
}

main().catch((err) => {
  console.error('prebundle failed:', err.message)
  process.exit(1)
})
