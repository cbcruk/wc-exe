# PoC — production build in the browser via bundler interception

Tests one claim from `docs/virtual-filesystem.md` (§2 layer C, §9): **a real
production bundle can be produced entirely in a browser tab** by swapping the
native bundler binary for its browser build and feeding it a virtual filesystem
instead of `node:fs`.

One pipeline: [`@rolldown/browser`](https://www.npmjs.com/package/@rolldown/browser)
(TypeScript + JS minify via oxc) plus
[`lightningcss-wasm`](https://www.npmjs.com/package/lightningcss-wasm) for CSS —
vite 8's toolchain, since vite 8's dependencies are `rolldown`, `lightningcss`
and `postcss`, with **no rollup and no esbuild**.

This is the path [almostnode](https://github.com/macaly/almostnode) demonstrates
for dev servers but never exercises for a production build — and a production
build is exactly wc-exe's job.

## Why only rolldown, when most projects still pin vite 5–7

A `@rollup/browser` + `esbuild-wasm` pipeline lived here too, matching vite 5–7
(vite 7.3.6 still depends on `rollup` and `esbuild`; only vite 8, released
2026-03-12, is rolldown-based). It was removed. The reasoning is worth keeping,
because the obvious objection — "our users are on vite 5, so we need the vite 5
pipeline" — does not hold:

> **Under interception the project's vite version does not choose the bundler.**
> We do not run the project's vite; we replace its pipeline. The React fixture
> pins `vite: ^5.4` and builds fine through rolldown, within 1% of what native
> `vite build` (5.4.21) emits.

So one bundler suffices, and the two are not equal:

|                                | rollup + esbuild-wasm                                                    | rolldown                                  |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------- |
| React (CommonJS deps)          | ❌ fails — needs `@rollup/plugin-commonjs`                               | ✅ oxc handles CJS natively               |
| can be handed a filesystem     | ❌ no — plugin hooks only                                                | ✅ `--vfs=memfs`                          |
| resolution correctness         | inherits our resolver, which **mis-resolves** `browser`/`imports` fields | rolldown's own resolver, correct          |
| bundle burst (vanilla fixture) | 366 / 511 ms                                                             | **144 / 153 ms**                          |
| COOP/COEP required             | no                                                                       | **yes** (wasi worker + SharedArrayBuffer) |
| download                       | small                                                                    | 10 MB wasm + 1.5 MB JS + 1.2 MB worker    |

The last two rows were the rollup path's whole case. Neither survives contact
with wc-exe: its server already sets COOP/COEP (WebContainer needs them anyway),
and the bundler is vendored locally rather than downloaded per build. What
remained was a pipeline that could not build a React app, could not use the only
VFS mode that resolves dependencies correctly, and doubled `build.js`.

Removing it took **118 lines** out of the PoC (`build.js` −85, `run.mjs` −33):
the `needsEsbuild` branching in `transform` and `renderChunk`, a second CSS
minifier, and a second preload strategy (`renderDynamicImport` + marker
replacement, which rolldown never calls). Every fixture's output is
**byte-identical** to before the removal.

Two claims now live only as history, since nothing in the tree demonstrates them
any more: the rollup path needed **no COOP/COEP** (unlike WebContainer,
container2wasm and rolldown), and its minified CSS was **byte-identical to
vite 5's**. Both are recorded below.

## Run

```bash
pnpm --dir poc/vite-build-intercept install             # once
pnpm --dir poc/vite-build-intercept prebundle:rolldown  # once
node poc/vite-build-intercept/run.mjs

# skip lightningcss (see its measured cost below)
node poc/vite-build-intercept/run.mjs --no-css-minify

# let rolldown's own resolver walk the VFS instead of ours (see below)
node poc/vite-build-intercept/run.mjs --vfs=memfs

# the fixture that separates the two resolvers (local packages, no install)
node poc/vite-build-intercept/run.mjs test/fixtures/sample-exports-app --vfs=memfs
```

Defaults to `test/fixtures/sample-vite-app`. Needs a Chromium (`CHROME_PATH` if
the lookup misses). Output lands in `poc/vite-build-intercept/out/` (gitignored).

To try the React fixture, install its dependencies first — the page resolves
bare specifiers out of the project's own `node_modules`:

```bash
npm --prefix test/fixtures/sample-react-app install
node poc/vite-build-intercept/run.mjs test/fixtures/sample-react-app
```

## Result: it works

Every fixture builds, and the emitted `dist/` runs.

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

Two alternating runs, all passing verification:

|                                 | rolldown                  | _(removed)_ rollup + esbuild-wasm |
| ------------------------------- | ------------------------- | --------------------------------- |
| toolchain init                  | 494 / 518 ms (10 MB wasm) | 309 / 349 ms                      |
| **bundle + minify (the burst)** | **144 / 153 ms**          | 366 / 511 ms                      |
| total in-page                   | 748 / 762 ms              | 814 / 932 ms                      |

**rolldown bundles ~2.4–3.5× faster**, and won on total time despite the heavier
init — one of the reasons the other pipeline is gone. For scale: native
`vite build` (vite 5, rollup+esbuild) on this same box self-reports **157 ms**,
so the _browser_ rolldown burst is already in the range of a _native_ vite 5
build.

> **Do not compare these to `bench/README.md`.** Those numbers were measured on
> macOS/M-series; these are from a Linux container. WebContainer cannot boot here
> (its runtime hosts are blocked), so the WebContainer-vs-interception
> comparison has to be run on one machine — and, per the next-steps list, run
> with its scope stated, since there is no install step on this side. That is
> the obvious next
> measurement.

### Fidelity vs a real `vite build` (same fixture)

|                                | `vite build` (native, v5) | this PoC (rolldown)  |
| ------------------------------ | ------------------------- | -------------------- |
| CSS asset                      | 673 B                     | 666 B (lightningcss) |
| JS asset                       | 1101 B                    | 384 B                |
| minified JS                    | ✅                        | ✅ oxc               |
| minified CSS                   | ✅ esbuild                | ✅ lightningcss      |
| TS transformed                 | ✅                        | ✅                   |
| CSS extracted to its own asset | ✅                        | ✅                   |
| hashed asset names             | ✅                        | ✅                   |
| modulepreload polyfill         | ✅ (~690 B)               | ❌                   |
| `<script>` hoisted to `<head>` | ✅                        | ❌                   |
| sourcemaps                     | on request                | ❌                   |

The JS gap is almost entirely vite's modulepreload polyfill. CSS is minified
with lightningcss, matching vite 8's toolchain — at a cost worth knowing about
(next section).

_History:_ the removed rollup path minified CSS with esbuild and came out at
**673 B, byte-identical to native vite 5's**. That was its best fidelity result
and it does not carry over; lightningcss and esbuild simply make different
choices. Nothing here depends on matching vite byte-for-byte, so the difference
is recorded rather than chased.

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
   worker, so cross-origin isolation is mandatory. This is the one constraint
   the removed rollup pipeline did not have.
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

- A browser tab can produce a working, minified, hashed production `dist/` from
  a VFS. (Two bundler generations could: the removed rollup pipeline did it too,
  for dependency-free projects.)
- **No CDN needed.** The bundler is served from local `node_modules`, so unlike
  almostnode there is no runtime dependency on esm.sh/unpkg.
- **No `npm install` needed for the bundler itself** — the build tool ships with
  wc-exe rather than being installed per project.
- _(No longer demonstrated here)_ that a browser build can avoid COOP/COEP
  entirely. The removed rollup pipeline did; rolldown cannot, and neither can
  WebContainer or container2wasm.

**Does not prove**

- **This is not `vite build` running.** It reimplements what vite does for a
  vanilla `index.html` app (entry discovery, TS transform, CSS extraction,
  hashed assets, HTML rewrite). Vite's config resolution, plugin ecosystem,
  framework plugins (`@vitejs/plugin-react`, svelte, …), `publicDir`, multi-page
  input, legacy targets and env/`define` handling are all absent.
- **Five fixtures.** React, code-splitting and the resolution shapes below all
  work, but these remain untried: worker/wasm imports, CSS `@import`/`url()`
  asset references, sourcemaps, multi-page input.
  `browser` field remaps, `imports` fields and deep `exports` wildcards **are**
  now covered (`sample-exports-app`) — and only `--vfs=memfs` gets them right.
- Nothing about `postinstall`, native addons, or anything else needing a real
  process.
- **It does not install anything.** See below — this is the largest gap, and
  the one most easily missed because every fixture happens to have a
  `node_modules` already sitting on disk.

### The gap that matters most: this does not run `npm install`

`run.mjs` reads `node_modules` out of the project directory. There is no install
step anywhere in the PoC — the README's own React instructions say
`npm --prefix … install` first. **Which means the interception path, as it
stands, does not deliver wc-exe's reason for existing.** The repo's premise is
that security software scanning tens of thousands of freshly written files makes
`npm install` unbearable; a build that requires those files to already be on
disk has not helped with that.

Put against the measured breakdown of a warm run, the piece it replaces is the
small one:

| step                           | measured | interception replaces it |
| ------------------------------ | -------- | ------------------------ |
| WebContainer boot              | ~5.4 s   | ❌                       |
| `npm install` (OPFS cache hit) | 0.30 s   | ❌ — it never runs one   |
| build                          | ~1.6 s   | ✅                       |

**But the wall may be lower than `docs/virtual-filesystem.md` §9 assumes.** That
section's blocker is step 5 of an install — lifecycle scripts, which need a
process model a VFS cannot provide. Measured on the React fixture:

|                                            |                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| packages installed                         | **71**                                                                            |
| packages with install hooks                | **3** — `csstype` (`prepublish`), `esbuild` (`postinstall`), `rollup` (`prepare`) |
| …of which matter to an interception build  | **0**                                                                             |
| runtime dependency closure                 | **5** — react, react-dom, scheduler, loose-envify, js-tokens                      |
| size: whole `node_modules` vs that closure | **44 MB** vs **5.0 MB**                                                           |

`prepublish` and `prepare` do not run on install at all, and `esbuild`'s
`postinstall` exists to fetch a native binary this pipeline never uses. And
66 of the 71 packages are devDependencies — vite, rollup, `@babel`,
`caniuse-lite` — which an interception build has no reason to install, because
it does not run vite.

So the shape of an install-free interception is visible: the host is Node, so it
could read the lockfile, fetch tarballs, and unpack them **in memory** straight
into the volume `--vfs=memfs` already populates, never touching disk. The
missing piece is exactly one thing — getting the bytes from the registry instead
of from `node_modules`.

That is **not proven**, and two known risks stand: generalising "no hooks
matter" from one fixture is the same mistake this PoC has now made twice, and
failing to reproduce npm's tree resolution (peer deps, `overrides`, optional and
platform deps, workspaces) breaks builds _silently_.

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

## The React test — and the CJS wall that decided the bundler

`test/fixtures/sample-react-app` (React 18 + react-dom, TSX, CSS import) is the
test that actually stresses dependency resolution:

| fixture              | rolldown               | _(removed)_ rollup   |
| -------------------- | ---------------------- | -------------------- |
| vanilla TS           | ✅ 161 ms · 384 B      | ✅ 314 ms · 413 B    |
| dynamic `import()`   | ✅ 160 ms · 2 chunks   | ✅ 440 ms · 2 chunks |
| shared-chunk preload | ✅ 231 ms · 4 chunks   | ✅ 414 ms · 4 chunks |
| **React**            | ✅ **470 ms · 141 KB** | ❌ **fails**         |

**rolldown builds React and the result works.** The runtime check passes: the
component mounts, the stylesheet applies, and clicking increments the counter —
so JSX, hooks and state all behave. That means bare-specifier resolution,
conditional `exports` maps and **CJS→ESM interop** all worked.

**rollup failed, exactly where predicted:**

```
RollupError: src/Counter.tsx (2:9): "useState" is not exported by
"node_modules/react/index.js", imported by "src/Counter.tsx"
```

React ships CommonJS. rollup cannot consume `module.exports` on its own — it
needs `@rollup/plugin-commonjs`, whose own dependency chain (`glob`, `resolve`,
…) would need the same prebundling exercise rolldown required. rolldown handles
CJS natively via oxc, so the problem never arises.

That was the first of the two findings that ended the rollup path; the second
was that it cannot be handed a filesystem, and so is stuck with a resolver that
mis-resolves real packages (see `sample-exports-app` below).

### Fidelity on React vs native `vite build`

|                       | native vite 5 + plugin-react | PoC (rolldown)        |
| --------------------- | ---------------------------- | --------------------- |
| JS                    | 142,671 B                    | **141,063 B** (−1.1%) |
| CSS                   | 159 B                        | 215 B (unminified)    |
| build time (same box) | 970 ms                       | 505 ms bundle burst   |

The JS lands within ~1% of a real React production build. The PoC is slightly
smaller because it omits vite's modulepreload polyfill. (The CSS row predates
lightningcss being wired up; with `--no-css-minify` off it is minified now.)

**This is also the measurement that makes the rollup path unnecessary rather
than merely worse:** this fixture pins `vite: ^5.4`, and rolldown reproduces
what its vite 5 build emits to within 1%. A project's pinned vite version does
not require the matching bundler here, because its vite is not what runs.

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
4. **JSX**: rolldown infers it.

## Handing the VFS to rolldown itself (`--vfs=memfs`)

The default VFS mode feeds the bundler through `resolveId`/`load`, which means
the 120 lines of conditional-`exports` walking in the previous section are
**ours to keep correct**. [vrowzer](https://github.com/kazupon/vrowzer) suggests the other
option: `@rolldown/browser`'s wasi binding creates a memfs volume and preopens
it at `/`, so writing the project into that volume makes rolldown's **own**
resolver do the work, exactly as it would against a real disk.

```bash
node poc/vite-build-intercept/run.mjs test/fixtures/sample-react-app --vfs=memfs
```

Three things make it work:

1. **The volume has to be reachable.** `@rolldown/browser` already exports it
   (`memfs` from its `experimental` entry, `{ fs, volume }`); the prebundle just
   re-exports that alongside the main entry, so page and bundler share one
   filesystem rather than two copies. vrowzer has to _replace_ the internal
   memfs to get this — they ship multiple bundles that must share a volume; the
   PoC bundles once, so it does not.
2. **One request, not 2,150.** The bundler's fs calls are synchronous, so
   nothing can be fetched on demand: the tree must be resident before the build
   starts. `/api/bulk` streams every file in one binary response.
3. **CSS still needs a plugin.** rolldown refuses CSS input, so stylesheets are
   still routed through a virtual module id. That is the only hook left.

### It works, and the output is byte-identical

All four fixtures build, and every emitted file matches the plugin-fed path
**down to the content hash** — `main-vIIrpq_x.js` (141,063 B) on React,
`main-4G6NDxoT.js` (384 B) on vanilla, same four chunks on the splitting
fixtures.

That is the result that matters: React's bare-specifier resolution, conditional
`exports` maps, subpaths (`react-dom/client`, `react/jsx-runtime`) and CJS→ESM
interop all came out the same when **rolldown** did them instead of us. The
hand-written resolver was a faithful reimplementation — and now it does not have
to be.

`platform: 'browser'` and `define: {'process.env.NODE_ENV': '"production"'}`
replace two more of the four additions the previous section lists. Only the
lazy VFS survives as ours, inverted.

### What it costs: laziness, and the bill is node_modules-sized

| React fixture            | plugin VFS | memfs VFS      |
| ------------------------ | ---------- | -------------- |
| get files in front of it | 16–17 ms   | 307–321 ms     |
| bundle + generate        | 194–197 ms | 192–195 ms     |
| **total in-page**        | **355 ms** | **634–653 ms** |

**The bundle burst is unchanged** — rolldown does not care where the bytes came
from. The entire difference is the VFS step, and it splits ~90/10 between
transferring the tree and writing it into memfs (278 ms fetch + 28 ms write on a
typical run). It is a transport problem, not a memfs problem.

On the vanilla fixture the two modes are a wash (299–303 ms vs 280–308 ms): with
no dependencies there is nothing to be eager about.

### Two thirds of that transfer was never a module

Unfiltered, the React fixture ships **44.5 MB** — and 17.9 MB of it is two
copies of the **esbuild native binary**, with another ~5 MB of `.map` and 3.6 MB
of `.node`. None of that can ever be a JavaScript module.

`/api/bulk` therefore skips files that cannot be one: `.map`, `.md`, `.flow`,
`.node`, `.d.ts`, and extensionless files whose first kilobyte contains a NUL
(`bin/rollup` is text and stays; `bin/esbuild` is not and goes). This is a
content filter, **not** a resolver — it decides nothing about where a specifier
points, which is the whole thing this mode hands back to rolldown.

| React fixture | files | sent        | VFS step       | total          |
| ------------- | ----- | ----------- | -------------- | -------------- |
| unfiltered    | 2,255 | 44.5 MB     | 482 ms         | 858 ms         |
| filtered      | 1,618 | **15.2 MB** | **307–321 ms** | **634–653 ms** |

Output stays byte-identical either way. `--no-bulk-filter` restores the
unfiltered transfer so the effect stays A/B-able.

### The fs-proxy payload cap: the one thing that did not need porting

vrowzer's most conspicuous patch raises `@napi-rs/wasm-runtime`'s fs-proxy
payload cap from ~10 KB to ~10 MB. The reasoning looks airtight: the wasi worker
allocates a `SharedArrayBuffer` per fs call and the page writes the result into
it, so a 130 KB react-dom read would overflow a 10 KB buffer.

**It does not.** React builds byte-identically at the **stock 10 KB**, and still
does at 1 KB. Module contents are read on the page's own WASI, not through the
worker proxy. Bisecting downward puts what actually crosses the proxy between
256 B and 1 KB — path strings and stat results.

So the patch is implemented but **off by default**; patching a dependency's
source to buy nothing is pure liability. It stays behind
`--fs-payload-bytes=<n>` only because of how overflow presents:

| cap           | result                              |
| ------------- | ----------------------------------- |
| 10 KB (stock) | builds                              |
| 1 KB          | builds                              |
| 256 B         | **renderer dies** — "Target closed" |
| 64 B          | **page hangs**, no error            |

Never `RangeError: payload overflow`, which the code does raise and which
nothing surfaces. A project that did overflow would present as a crash or a
stall with nothing pointing here — worth a documented one-flag escape hatch,
not worth a standing patch.

### Verdict: not a code saving, a trade

|                             | plugin VFS            | memfs VFS                        |
| --------------------------- | --------------------- | -------------------------------- |
| resolution semantics we own | 109 code lines        | **0**                            |
| plumbing we own             | lazy manifest + fetch | 71 (page) + 78 (host) code lines |
| dependency patched          | none                  | none                             |
| React total                 | 355 ms                | 634–653 ms                       |

The line counts are close to a wash. What changes is their **character**: 109
lines of resolution semantics that have to match Node's algorithm — and that
`docs/virtual-filesystem.md` lists as the source of the untested ecosystem
shapes (`browser` field remaps, deep `exports` wildcards) — become ~150 lines of
transport that is either right or obviously broken.

Whether that trade is worth ~1.8× on a React build depends on how much those
shapes matter — and the next section stops that being a guess.

## The resolution shapes that decide it (`sample-exports-app`)

The trade above is only worth taking if the hand-written resolver actually gets
things wrong. `test/fixtures/sample-exports-app` settles that. It ships four
tiny local packages, each with a **`node` file and a `browser` file carrying
different markers**, and `resolution-expectations.json` names which marker must
appear in the bundle and which must not. Picking the wrong file is otherwise a
_silent success_ — the build works, it just ships the wrong source.

Ground truth first: **native `vite build` (5.4.21) resolves all four to the
browser variant.** So a mismatch is a bug, not a matter of taste.

| shape                                                | native vite | plugin VFS (our resolver) | memfs VFS (rolldown) |
| ---------------------------------------------------- | ----------- | ------------------------- | -------------------- |
| legacy `browser` field, string form                  | browser     | ❌ **node, silently**     | ✅ browser           |
| legacy `browser` field, object remap                 | browser     | ❌ **node, silently**     | ✅ browser           |
| `imports` field (`#internal`, resolved by condition) | browser     | ❌ left external → crash  | ✅ browser           |
| `exports` wildcard spanning path segments            | ✅          | ✅                        | ✅                   |

```
plugin VFS:
  ✗ static: resolution: bundle contains BROWSER_STRING_WRONG_NODE
  ✗ static: resolution: bundle contains BROWSER_MAP_WRONG_NODE
  ✗ runtime: Failed to resolve module specifier "#internal"
memfs VFS:
  ✓ static  ✓ runtime
```

(The removed rollup path failed identically — the resolver was shared. Its
inability to use `--vfs=memfs` is what made those failures permanent rather
than fixable, and is the second reason it is gone.)

**The two `browser`-field rows are the important ones.** They do not fail; they
_succeed wrongly_. The bundle is well-formed, the app renders, and it has
quietly linked the Node build of a dependency into a browser bundle. That is the
failure class this PoC keeps finding (CSS read before `generate()`, hash
coherence) and the one a fixture is the only defence against.

`docs/virtual-filesystem.md` listed `browser` field remaps and deep `exports`
wildcards as untested. They are now tested: the wildcards were fine, the
`browser` field was never implemented at all, and `imports` neither. On
`--vfs=memfs` all three stop being ours to get right.

### Two bugs the fixture caught on the way in

1. **The dependency scan was dropping `node_modules/**/dist/`.** `listFiles`applied the *project's* ignore set — which contains`dist`and`coverage`,
correctly, for the project's own output — to node_modules as well. Every
package that ships from `dist/`was invisible; the build then emitted an
external import with only a warning. React never tripped it (its packages
ship from`cjs/`/`umd/`), and the new fixture did on the first run. Both VFS
   modes were affected. Fixed by giving node_modules its own ignore set; the
   React volume grew 1,552 → 1,618 files and its output stayed byte-identical.
2. **A crashing runtime check hid the static report.** `verifyBuiltAppRuns`
   threw out of the whole run on the first missing selector, so a resolution
   failure presented as `failed to find element matching selector "#counter"`
   with nothing about resolution. It now records the abort as a problem and the
   static findings survive — which is how the table above became legible.

## lightningcss on the rolldown path: works, but the second wasm is not free

vite 8 minifies CSS with lightningcss, so the rolldown path uses
`lightningcss-wasm` to match. Wiring it was easy compared with rolldown: it is
one ESM entry whose wasm resolves relative to the module URL, and its only bare
import (`napi-wasm`, a single dependency-free ESM file) needs just an import-map
entry — **no prebundling**.

It works, and the CSS output is good: **870 B unminified → 666 B**, which is
7 B _smaller_ than esbuild's 673 B. lightningcss also reorders declarations and
shortens values further (`transparent` → `#0000`).

**But loading a second wasm module measurably slows the build.** Interleaved
A/B runs, 4 pairs, same fixture and machine:

|                                    | toolchain init | bundle burst | CSS   |
| ---------------------------------- | -------------- | ------------ | ----- |
| rolldown + lightningcss            | 1001–1074 ms   | 344–393 ms   | 666 B |
| rolldown alone (`--no-css-minify`) | 478–527 ms     | 154–171 ms   | 870 B |

Init roughly doubles (+~500 ms, lightningcss's own instantiation — expected),
but the **bundle burst also more than doubles** (+~190 ms), which it cannot be
doing on 800 bytes of CSS. That points at the cost of a second wasm instance in
the page rather than the transform itself. Consistent across all four pairs, so
not noise.

**Judgment:** for a small stylesheet this is a bad trade — roughly +690 ms to
save 204 B. It only pays off on CSS-heavy projects. lightningcss stays **on by
default** on the rolldown path because that path exists to mirror vite 8, and
`--no-css-minify` opts out; the flag also keeps the bundler-only measurement
recoverable.

## The `__vitePreload` equivalent: implemented, and it removes the waterfall

Emitting a bare `import()` means the browser only discovers a lazy chunk's own
dependencies _after_ fetching and parsing that chunk — one extra round trip per
level. vite avoids this with `__vitePreload`, which injects
`<link rel="modulepreload">` for the target's dependencies before importing it.
The PoC now does the same, as `__wcPreload`.

`test/fixtures/sample-preload-app` makes the waterfall real: two dynamic
imports whose targets both statically import `./shared`, so the bundler hoists
`shared` into its own chunk that the feature chunks depend on.

**Measured** with an artificial 200 ms delay on chunk requests
(`--chunk-delay=200`), interleaved A/B, 3 pairs — time from click to the
lazily-rendered text appearing:

|                    | preload on         | preload off (`--no-preload`) |
| ------------------ | ------------------ | ---------------------------- |
| rolldown           | 234 / 236 / 238 ms | 435 / 441 / 444 ms           |
| _(removed)_ rollup | 230 / 237 / 241 ms | 439 / 442 / 444 ms           |

One round trip instead of two — **~1.9x faster, saving a full ~200 ms hop** — and
the numbers land exactly where the theory says (1x vs 2x the injected delay).

Emitted shape, matching vite's:

```js
__wcPreload(
  () => import('./featureA-CGZr6uFs.js'),
  ['/assets/shared-D6P-CrGZ.js']
)
```

Native vite on the same fixture produces the same chunk graph (its `shared`
chunk is byte-identical to ours, hash included) and its entry likewise carries
`modulepreload` plus the shared chunk's name — so this matches vite's
behaviour, not just its file layout.

### rolldown does not call `renderDynamicImport`

vite's own approach is two-phase: `renderDynamicImport` wraps each import with a
marker, then `generateBundle` — where final filenames exist — replaces markers
with the dependency list. **rolldown never calls `renderDynamicImport`.** With
preload on it silently produced an unwrapped entry (766 B, no helper) and the
lazy load still took 442 ms, i.e. the full waterfall — a quiet wrong answer, not
an error.

`generateBundle` _is_ called, so the wrapping happens there instead, rewriting
the already-emitted `import("./chunk.js")` calls. That brings it to 228 ms. The
marker machinery existed only for the rollup path and went with it; what remains
is the `generateBundle` rewrite, which was always the one rolldown used.

### Rewriting after hashing was a cache-poisoning bug — now fixed

The preload wiring mutates chunk code in `generateBundle`, i.e. **after** the
bundler has hashed it. That means a chunk's name stopped identifying its
bytes. The failure is not theoretical — building the same fixture with and
without preload produced:

```
rolldown preload ON : main-BuyLOJ80.js  1263 B  md5 f829…
rolldown preload OFF: main-BuyLOJ80.js   766 B  md5 5a5b…
```

**Same filename, different content.** Anything caching by URL — a CDN, a
browser, a service worker — would serve one build's bytes for the other.

The fix rehashes any chunk that was rewritten and renames it, updating the HTML
entry reference to match. Renaming a chunk that another chunk imports by name
would have to cascade into those importers (and rehash them in turn); nothing
in the fixtures hits that, so the build **throws rather than emit dangling
references**.

After the fix the names diverge as they should, on both paths:

|          | preload on         | preload off        |
| -------- | ------------------ | ------------------ |
| rolldown | `main-25dff951.js` | `main-BuyLOJ80.js` |
| rollup   | `main-d5c07138.js` | `main-aC2H4x2L.js` |

Rehashed names use an 8-hex-char sha256 prefix, so a rewritten chunk is
visually distinguishable from one the bundler named. Repeat builds of identical
input produce identical names.

The harness now asserts the invariant directly: for any chunk containing the
helper, the hash in its filename must equal a hash of its bytes. Disabling the
rehash makes that check fail, so it has teeth:

```
✗ static: rewritten chunk's name does not match its content hash: main-BuyLOJ80.js
```

vite reaches the same outcome differently, using rollup's hash placeholders so
the final content is what gets hashed in the first place. Renaming afterwards is
the equivalent for a post-processing pipeline like this one.

## Code splitting

`test/fixtures/sample-dynamic-app` adds `await import('./lazy')` behind a
button. The bundler produces a genuinely separate chunk, and the harness proves
it two ways — statically (the lazy marker appears in exactly one chunk and _not_
in the entry, and every `import()` target exists on disk) and at runtime
(clicking fetches the chunk and its export renders).

|            | native vite 5 | this PoC (rolldown) | _(removed)_ rollup         |
| ---------- | ------------- | ------------------- | -------------------------- |
| entry      | 2346 B        | 560 B               | 591 B                      |
| lazy chunk | 76 B          | 64 B                | **76 B — byte-identical**  |
| CSS        | 159 B         | 215 B (unminified)  | **159 B — byte-identical** |

The byte-identical column is the removed pipeline's, and is the sharpest
fidelity result this PoC ever produced — recorded because it is the thing that
went away, not because anything depends on it.

**The entry gap is functional, not cosmetic.** vite's 2346 B entry carries the
modulepreload polyfill _and_ `__vitePreload`, which wraps every dynamic import
so the chunk's own dependencies are preloaded in parallel. The PoC emits a bare
`import()`. For this fixture the lazy chunk has no dependencies so nothing
differs, but for a real app with shared chunks vite avoids a request waterfall
that this PoC would incur. That is the honest missing piece, now item 4 in the
next steps.

**One difference worth knowing:** oxc (rolldown's minifier) emits string
literals as **backtick templates** — ``import(`./lazy-hLdNd2Sa.js`)`` where
esbuild wrote `import("./lazy-BymLrvT9.js")`. A chunk-reference check that only
accepts quotes reports a false failure on a build that is actually correct; this
harness hit exactly that.

## Next steps, in order of what they would settle

1. **Make the interception path install** (see the gap section above). Until it
   does, it is not solving the problem wc-exe exists for, and item 2 cannot be
   an honest comparison.
2. **Same-machine benchmark** against WebContainer's `npm run build`. Note what
   it can and cannot answer today: with no install step here, it compares
   **build time given an existing `node_modules`** — roughly a fifth of a warm
   WebContainer run (boot ~5.4 s + install 0.30 s + build ~1.6 s). Run it that
   way and say so, or run it after item 1 and get a comparison of two paths
   doing the same job.
3. ~~A project with real dependencies~~ / ~~dynamic-import chunking~~ — **done.**
4. ~~`lightningcss-wasm` on the rolldown path~~ — **done, see above.**
5. ~~A `__vitePreload`-equivalent~~ / ~~hash coherence~~ — **done, see above.**
6. ~~Hand the VFS to rolldown's own resolver (`--vfs=memfs`)~~ — **done, see
   above.** ~1.8× on React, and it is the only mode that resolves the shapes in
   `sample-exports-app` correctly.
7. ~~A fixture that separates the two resolvers~~ — **done**
   (`sample-exports-app`, ground-truthed against native `vite build`).
8. Only then: plugin compatibility, sourcemaps, multi-page input, asset
   references.
