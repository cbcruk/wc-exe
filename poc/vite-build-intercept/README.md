# PoC — production build in the browser via bundler interception

Tests one claim from `docs/virtual-filesystem.md` (§2 layer C, §9): **a real
production bundle can be produced entirely in a browser tab** by swapping the
native bundler binaries for their browser builds and feeding them a virtual
filesystem instead of `node:fs`.

- `rollup` → [`@rollup/browser`](https://www.npmjs.com/package/@rollup/browser)
- `esbuild` → [`esbuild-wasm`](https://www.npmjs.com/package/esbuild-wasm) (both
  the TS transform **and** minification, as vite uses it)
- `node:fs` → an in-memory VFS filled over HTTP from the host

This is the path [almostnode](https://github.com/macaly/almostnode) demonstrates
for dev servers but never exercises for a production build — and a production
build is exactly wc-exe's job.

## Run

```bash
pnpm --dir poc/vite-build-intercept install    # once
node poc/vite-build-intercept/run.mjs [projectDir]
```

Defaults to `test/fixtures/sample-vite-app`. Needs a Chromium (`CHROME_PATH` if
the lookup misses). Output lands in `poc/vite-build-intercept/out/` (gitignored).

## Result: it works

```
=== OUTPUT ===
  assets/main-Ct_UrpaZ.js                413 B
  assets/style-3668417e.css              673 B
  index.html                             398 B

=== VERIFY ===
  ✓ static: HTML→assets resolve, TS transformed,
    module graph bundled, CSS extracted out of JS
  ✓ runtime: built app renders, stylesheet applies,
    counter increments on click (transformed TS behaves)
```

The runtime check is the one that matters: the emitted `dist/` is served and
**actually loaded in a browser** — the app renders, the extracted stylesheet
applies, and clicking the counter increments it. So the transformed TypeScript
behaves, the module graph is intact, and the HTML/JS/CSS wiring is correct.

### Fidelity vs a real `vite build` (same fixture)

|                                  | `vite build` (native) | this PoC (browser)                |
| -------------------------------- | --------------------- | --------------------------------- |
| CSS asset                        | 673 B                 | **673 B — byte-identical**        |
| JS asset                         | 1101 B                | 413 B                             |
| minified                         | ✅                    | ✅ (esbuild-wasm)                 |
| TS transformed                   | ✅                    | ✅                                |
| CSS extracted to its own asset   | ✅                    | ✅                                |
| hashed asset names               | ✅                    | ✅ (hashing sees minified output) |
| modulepreload polyfill injected  | ✅ (~690 B)           | ❌                                |
| `<script>` hoisted into `<head>` | ✅                    | ❌ (left in `<body>`)             |
| sourcemaps                       | on request            | ❌                                |

The minified CSS comes out **byte-identical to vite's**, and the JS difference
is almost entirely vite's modulepreload polyfill; the app code itself matches
apart from top-level name mangling. Fidelity on this fixture is high.

### Timing (this Linux sandbox — see the caveat below)

| phase                           | ms           |
| ------------------------------- | ------------ |
| esbuild-wasm init               | ~310–350     |
| VFS load (8 files over HTTP)    | ~90–110      |
| **bundle + minify (the burst)** | **~305–435** |
| upload dist to host             | ~30–80       |
| total in-page                   | ~745–955     |

Same-machine anchor: native `vite build` on this box self-reports **157 ms**
(~1.09 s wall including `npx`/node startup). So the browser path is roughly
**2–3× slower than native vite** for the bundle itself.

> **Do not compare these to the numbers in `bench/README.md`.** Those were
> measured on macOS/M-series; these are from a Linux container. WebContainer
> cannot boot here (its runtime hosts are blocked), so the
> WebContainer-vs-interception comparison has to be run on one machine — that
> is the obvious next measurement.

## What this proves — and what it does not

**Proves**

- `@rollup/browser` + `esbuild-wasm` can bundle a real TS app from a VFS in a
  browser and emit a working, minified, hashed production `dist/`.
- **No COOP/COEP needed.** esbuild-wasm's async API and `@rollup/browser` work
  without `SharedArrayBuffer`, unlike WebContainer and container2wasm. One less
  deployment constraint.
- **No CDN needed.** Both bundlers are served from local `node_modules`, so
  unlike almostnode there is no runtime dependency on esm.sh/unpkg.
- **No `npm install` needed for the bundler itself** — the build tool ships with
  wc-exe rather than being installed per project.

**Does not prove**

- **This is not `vite build` running.** It reimplements what vite does for a
  vanilla `index.html` app (entry discovery, TS transform, CSS extraction,
  hashed assets, HTML rewrite). Vite's config resolution, plugin ecosystem,
  framework plugins (`@vitejs/plugin-react`, svelte, …), `publicDir`, multi-page
  input, legacy targets and env/`define` handling are all absent.
- **Dependencies are untested.** The fixture has zero runtime deps, so the
  bare-specifier resolver in `browser/build.js` never runs. Real projects need
  conditional `exports` maps and CJS→ESM interop, which is where this approach
  gets genuinely hard.
- Nothing about `postinstall`, native addons, or anything else that needs a real
  process.

### Why not just port vite?

Measured on vite 5.4's shipped `dist/node`: it imports **24 node builtins** —
including `node:child_process`, `node:worker_threads`, `node:net`, `node:tls`,
`node:dns`, `node:inspector`, `node:module` — and at least one chunk uses
`execSync`/`spawnSync`, which is precisely the wall almostnode hits (its
`execSync` shim throws). Porting vite means shimming all of that; the approach
here needs none of it, because it **replaces** vite's pipeline instead of
running it.

That is the strategic point: bypassing vite is far cheaper than porting vite —
but you pay for it in ecosystem compatibility, and for wc-exe (whose promise is
"build an _arbitrary_ project") that bill is the whole question.

## Next steps, in order of what they would settle

1. **Same-machine benchmark** against WebContainer's `npm run build` — the only
   number that decides whether this is faster in practice.
2. **A project with real dependencies** (e.g. React) — exercises bare-specifier
   resolution, `exports` maps and CJS interop. Expect this to be where it breaks.
3. Only then: plugin compatibility, sourcemaps, multi-page input.
