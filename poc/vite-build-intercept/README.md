# PoC — production build in the browser via bundler interception

Tests one claim from `docs/virtual-filesystem.md` (§2 layer C, §9): **a real
production bundle can be produced entirely in a browser tab** by swapping the
native bundler binaries for their browser builds and feeding them a virtual
filesystem instead of `node:fs`.

Two pipelines are implemented, matching two eras of vite:

| flag                 | pipeline | tools                                                                                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _(default)_          | vite 5   | [`@rollup/browser`](https://www.npmjs.com/package/@rollup/browser) + [`esbuild-wasm`](https://www.npmjs.com/package/esbuild-wasm) (transform **and** minify) |
| `--bundler=rolldown` | vite 8   | [`@rolldown/browser`](https://www.npmjs.com/package/@rolldown/browser) alone — it transforms TS and minifies itself via oxc                                  |

vite 8.1.5's dependencies are `rolldown`, `lightningcss` and `postcss` — **no
rollup, no esbuild** — so the rolldown path is what intercepting a current vite
actually means.

This is the path [almostnode](https://github.com/macaly/almostnode) demonstrates
for dev servers but never exercises for a production build — and a production
build is exactly wc-exe's job.

## Run

```bash
pnpm --dir poc/vite-build-intercept install              # once
node poc/vite-build-intercept/run.mjs                    # rollup + esbuild-wasm

pnpm --dir poc/vite-build-intercept prebundle:rolldown   # once, for rolldown
node poc/vite-build-intercept/run.mjs --bundler=rolldown
```

Defaults to `test/fixtures/sample-vite-app`. Needs a Chromium (`CHROME_PATH` if
the lookup misses). Output lands in `poc/vite-build-intercept/out/` (gitignored).

To try the React fixture, install its dependencies first — the page resolves
bare specifiers out of the project's own `node_modules`:

```bash
npm --prefix test/fixtures/sample-react-app install
node poc/vite-build-intercept/run.mjs test/fixtures/sample-react-app --bundler=rolldown
```

## Result: it works — with one split

Both pipelines build the dependency-free fixture. On a **React** project only
rolldown succeeds; rollup fails on CommonJS (see the React section below).

```
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

### Timing (this Linux sandbox — see the caveat)

Two alternating runs each, all passing verification:

|                                 | rollup + esbuild-wasm | rolldown                  |
| ------------------------------- | --------------------- | ------------------------- |
| toolchain init                  | 309 / 349 ms          | 494 / 518 ms (10 MB wasm) |
| **bundle + minify (the burst)** | **366 / 511 ms**      | **144 / 153 ms**          |
| total in-page                   | 814 / 932 ms          | 748 / 762 ms              |

**rolldown bundles ~2.4–3.5× faster**, and wins on total time despite the
heavier init. For scale: native `vite build` (vite 5, rollup+esbuild) on this
same box self-reports **157 ms** — so the _browser_ rolldown burst is already in
the same range as a _native_ vite 5 build.

> **Do not compare these to `bench/README.md`.** Those numbers were measured on
> macOS/M-series; these are from a Linux container. WebContainer cannot boot here
> (its runtime hosts are blocked), so the WebContainer-vs-interception
> comparison has to be run on one machine — that is the obvious next
> measurement.

### Fidelity vs a real `vite build` (same fixture)

|                                | `vite build` (native, v5) | rollup path                | rolldown path      |
| ------------------------------ | ------------------------- | -------------------------- | ------------------ |
| CSS asset                      | 673 B                     | **673 B — byte-identical** | 870 B (unminified) |
| JS asset                       | 1101 B                    | 413 B                      | 384 B              |
| minified JS                    | ✅                        | ✅ esbuild-wasm            | ✅ oxc             |
| minified CSS                   | ✅                        | ✅                         | ❌ (see below)     |
| TS transformed                 | ✅                        | ✅                         | ✅                 |
| CSS extracted to its own asset | ✅                        | ✅                         | ✅                 |
| hashed asset names             | ✅                        | ✅                         | ✅                 |
| modulepreload polyfill         | ✅ (~690 B)               | ❌                         | ❌                 |
| `<script>` hoisted to `<head>` | ✅                        | ❌                         | ❌                 |
| sourcemaps                     | on request                | ❌                         | ❌                 |

On the rollup path the minified CSS is **byte-identical to vite's**, and the JS
gap is almost entirely vite's modulepreload polyfill. The rolldown path leaves
CSS unminified because only esbuild-wasm is loaded there; matching vite 8 would
mean adding [`lightningcss-wasm`](https://www.npmjs.com/package/lightningcss-wasm)
(it exists — the whole vite 8 toolchain has browser builds).

## What wiring rolldown actually costs

`@rollup/browser` can be `import`ed by a page as shipped. `@rolldown/browser`
cannot, and every step below was a real failure hit while building this:

1. **Prebundling is mandatory.** Its browser entry statically imports `node:fs`
   and `node:url`, and its wasi binding imports `@napi-rs/wasm-runtime` →
   `@tybys/wasm-util` → `@emnapi/*` as bare specifiers. A page cannot resolve
   that chain, so `scripts/prebundle-rolldown.mjs` bundles it with those node
   builtins pointed at stubs in `browser/shim/`.
2. **The wasi worker must be prebundled too**, and keep its exact filename —
   the binding does `new Worker(new URL('./wasi-worker-browser.mjs',
import.meta.url))`, and **workers do not inherit the page's import map**, so
   its bare specifiers have to be bundled away separately.
3. **A `process` global is required**; rolldown's option normalizer reads it.
   The prebundle injects a minimal one via a banner.
4. **COOP/COEP is required.** The binding transfers a `SharedArrayBuffer` to its
   worker, so cross-origin isolation is mandatory — the rollup path's freedom
   from those headers does **not** carry over.
5. **CSS input is rejected outright**: _"Bundling CSS is no longer supported
   (experimental support has been removed)"_. Stylesheets must be routed through
   a virtual module id, and that id must not _end_ in `.css` either, since
   rolldown picks a module type from the suffix.
6. **Module loading is deferred to `generate()`.** rollup populates plugin state
   during `rollup()`; rolldown does not, so reading collected CSS before
   `generate()` silently produced no stylesheet at all — a quiet wrong answer,
   not an error.
7. Top-level await in the binding forces an `es2022` prebundle target.

Also note the size: 10 MB of wasm plus ~1.5 MB of JS for rolldown, plus another
~1.2 MB for the bundled worker.

## What this proves — and what it does not

**Proves**

- Both bundler generations can produce a working, minified, hashed production
  `dist/` from a VFS inside a browser tab.
- **No CDN needed.** Bundlers are served from local `node_modules`, so unlike
  almostnode there is no runtime dependency on esm.sh/unpkg.
- **No `npm install` needed for the bundler itself** — the build tool ships with
  wc-exe rather than being installed per project.
- On the rollup path, **no COOP/COEP needed** either (unlike WebContainer,
  container2wasm, and rolldown).

**Does not prove**

- **This is not `vite build` running.** It reimplements what vite does for a
  vanilla `index.html` app (entry discovery, TS transform, CSS extraction,
  hashed assets, HTML rewrite). Vite's config resolution, plugin ecosystem,
  framework plugins (`@vitejs/plugin-react`, svelte, …), `publicDir`, multi-page
  input, legacy targets and env/`define` handling are all absent.
- **Three fixtures.** React and code-splitting work (below), but ecosystem
  shapes remain untried: packages with `browser` field remaps, deep `exports`
  wildcards, worker/wasm imports, CSS `@import`/`url()` asset references.
- Nothing about `postinstall`, native addons, or anything else needing a real
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

## The React test: rolldown passes, rollup fails on CJS

`test/fixtures/sample-react-app` (React 18 + react-dom, TSX, CSS import) is the
test that actually stresses dependency resolution — and it splits the two
pipelines cleanly:

| fixture            | rollup (vite 5)      | rolldown (vite 8)      |
| ------------------ | -------------------- | ---------------------- |
| vanilla TS         | ✅ 314 ms · 413 B    | ✅ 161 ms · 384 B      |
| dynamic `import()` | ✅ 440 ms · 2 chunks | ✅ 160 ms · 2 chunks   |
| **React**          | ❌ **fails**         | ✅ **470 ms · 141 KB** |

**rolldown builds React and the result works.** The runtime check passes: the
component mounts, the stylesheet applies, and clicking increments the counter —
so JSX, hooks and state all behave. That means bare-specifier resolution,
conditional `exports` maps and **CJS→ESM interop** all worked.

**rollup fails, exactly where predicted:**

```
RollupError: src/Counter.tsx (2:9): "useState" is not exported by
"node_modules/react/index.js", imported by "src/Counter.tsx"
```

React ships CommonJS. rollup cannot consume `module.exports` on its own — it
needs `@rollup/plugin-commonjs`, whose own dependency chain (`glob`, `resolve`,
…) would need the same prebundling exercise rolldown required. rolldown handles
CJS natively via oxc, so the whole problem disappears on that path.

**This is not worth fixing on the rollup path.** Current vite is rolldown
(8.1.5's deps have no rollup and no esbuild), so the CJS gap is a property of
the legacy pipeline. The rollup path stays in the repo as the
no-COOP/COEP, smaller-download variant for dependency-free projects.

### Fidelity on React vs native `vite build`

|                       | native vite 5 + plugin-react | PoC (rolldown)        |
| --------------------- | ---------------------------- | --------------------- |
| JS                    | 142,671 B                    | **141,063 B** (−1.1%) |
| CSS                   | 159 B                        | 215 B (unminified)    |
| build time (same box) | 970 ms                       | 505 ms bundle burst   |

The JS lands within ~1% of a real React production build. The PoC is slightly
smaller because it omits vite's modulepreload polyfill; the CSS is larger only
because the rolldown path does not minify CSS yet.

### What resolving real dependencies actually required

Beyond the vanilla case, React forced four additions to `browser/build.js`:

1. **Lazy VFS.** node*modules is 2,150 files; fetching them all would dominate
   the build. The page now loads a \_manifest* of paths eagerly (so resolution
   stays synchronous) and fetches _contents_ only for files the graph reaches.
2. **Conditional `exports` maps** — `react` exposes `{".": {"react-server":…,
"default":…}}` and subpaths like `react/jsx-runtime`; `react-dom/client` needs
   subpath resolution. Implemented with a condition order of
   `browser → import → module → default → require`, plus single-`*` patterns.
3. **`process.env.NODE_ENV` substitution.** React picks its dev or production
   build from it, and nothing defines `process` in a page — the same job vite's
   `define` does.
4. **JSX**: `jsx: 'automatic'` for esbuild-wasm on the rollup path; rolldown
   infers it.

## Code splitting: both pipelines split, one caveat

`test/fixtures/sample-dynamic-app` adds `await import('./lazy')` behind a
button. Both bundlers produce a genuinely separate chunk, and the harness
proves it two ways — statically (the lazy marker appears in exactly one chunk
and _not_ in the entry, and every `import()` target exists on disk) and at
runtime (clicking fetches the chunk and its export renders).

|            | native vite 5 | rollup path                | rolldown path      |
| ---------- | ------------- | -------------------------- | ------------------ |
| entry      | 2346 B        | 591 B                      | 560 B              |
| lazy chunk | 76 B          | **76 B — byte-identical**  | 64 B               |
| CSS        | 159 B         | **159 B — byte-identical** | 215 B (unminified) |

On the rollup path both the lazy chunk **and** the CSS come out byte-identical
to a real `vite build`.

**The entry gap is functional, not cosmetic.** vite's 2346 B entry carries the
modulepreload polyfill _and_ `__vitePreload`, which wraps every dynamic import
so the chunk's own dependencies are preloaded in parallel. The PoC emits a bare
`import()`. For this fixture the lazy chunk has no dependencies so nothing
differs, but for a real app with shared chunks vite avoids a request waterfall
that this PoC would incur. That is the honest missing piece, now item 4 in the
next steps.

**One difference worth knowing:** oxc (rolldown's minifier) emits string
literals as **backtick templates** — `import(\`./lazy-hLdNd2Sa.js\`)`where
esbuild writes`import("./lazy-BymLrvT9.js")`. A chunk-reference check that only
accepts quotes reports a false failure on a build that is actually correct; this
harness hit exactly that.

## Next steps, in order of what they would settle

1. **Same-machine benchmark** against WebContainer's `npm run build` — the only
   number that decides whether this is faster in practice.
2. ~~A project with real dependencies~~ / ~~dynamic-import chunking~~ — **done.**
3. `lightningcss-wasm` on the rolldown path, to match vite 8's CSS handling.
4. A `__vitePreload`-equivalent, so a lazy chunk's own dependencies get
   preloaded instead of discovered as a request waterfall (see below).
5. Only then: plugin compatibility, sourcemaps, multi-page input.
