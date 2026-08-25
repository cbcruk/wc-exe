# Benchmarks — WebContainer vs container2wasm

Goal: settle one number that decides whether container2wasm can replace
WebContainer as wc-exe's build engine — **the wall-clock cost of the CPU-bound
build burst under Wasm emulation.**

See `docs/virtual-filesystem.md` §7 for the reasoning. TL;DR: booting, the
virtual filesystem, and networking are already proven to work in the browser
(WebContainer today; [vscode-container-wasm](https://github.com/ktock/vscode-container-wasm)
for container2wasm). The only open variable is whether emulated CPU makes
`npm run build` unacceptably slow. These harnesses measure exactly that.

> Run these on **your own machine** — ideally the one whose security software
> wc-exe exists to work around. Numbers from a clean CI box or this repo's
> sandbox aren't representative of your real I/O/CPU picture.

## Headline comparison: the `build` phase

`npm run build` (vite/rollup/esbuild) is the CPU-heavy part — the part
WebContainer runs near-native and the part emulation is expected to tax.
`npm install` is more I/O/network bound and is measured only on the
WebContainer side (see notes).

| engine         | what runs the CPU work                     | how to measure                            |
| -------------- | ------------------------------------------ | ----------------------------------------- |
| WebContainer   | StackBlitz's in-browser Node (near-native) | `node bench/webcontainer.mjs` → `buildMs` |
| container2wasm | QEMU/emulated CPU in Wasm                  | `bench/container2wasm/run.sh` → `buildMs` |

## 1. WebContainer baseline

```bash
pnpm build                 # builds dist/ + src/runner/dist that the harness imports
node bench/webcontainer.mjs test/fixtures/sample-vite-app --runs 3
```

Needs a Chrome/Chromium binary — set `CHROME_PATH` if the default lookup
(`src/core/browser.ts`) misses it. Prints per-run and averaged
`bootMs / mountMs / installMs / buildMs`. Compare `buildMs`.

### Warm mode (`--cache`) — the persistent-runner Phase 0 question

The default mode is cold on purpose: it is the container2wasm baseline. But
once the OPFS cache lands, a _cold_ breakdown says nothing about day-to-day
cost. `docs/persistent-runner.md` §8 Phase 0 asks a different question — **on a
warm run, is boot actually dominant enough to justify a daemon?** — and that
needs warm numbers.

```bash
node bench/webcontainer.mjs ../my-real-project --cache --runs 4
```

`--cache` pins the runner to the fixed port and a persistent Chrome profile
(the same two things the real `--cache` flag needs, for the same reason: OPFS is
origin-scoped), then installs through `installWithCache`. **Run 1 seeds the
cache and is excluded from `warmAverage`**; runs 2..N are the measurement. The
cache lives in a temp dir, not your real `~/.cache/wc-exe`, and is wiped at
start unless you pass `--keep-cache`.

It then prints each phase's share of the warm total and splits it three ways:

| bucket           | phases         | why                                                       |
| ---------------- | -------------- | --------------------------------------------------------- |
| amortizable      | boot + install | a live container removes both outright                    |
| replaced by sync | mount          | becomes manifest-diff sync, at a cost nobody has measured |
| irreducible      | build          | same work either way                                      |

and ends with a **GO / STOP** call: GO if boot is ≥30% of the warm run, STOP
otherwise. STOP is a real outcome, not a failure — on a project whose build
dwarfs boot, the daemon buys little and Phase 0 is where to stop. The reported
win is an **upper bound**: manifest sync is not yet subtracted from it.

The arithmetic behind that call lives in `bench/report.mjs` and is unit-tested
(`bench/webcontainer.test.mjs`), because a sign error there would misdirect the
whole design.

## 2. container2wasm

```bash
bench/container2wasm/run.sh test/fixtures/sample-vite-app
```

Prereqs (all run locally): Docker daemon (Docker Desktop / OrbStack / colima)
and a WASI runtime ([`wasmtime`](https://wasmtime.dev)). The c2w binary and its
build assets are downloaded automatically on first run. It bakes `node_modules`
natively, converts the image to Wasm, and times `npm run build`.

**This is a conservative upper bound.** The default WASI-runtime emulator
(Bochs) is slower than the in-browser QEMU-Wasm JIT (TCG) that production and
vscode-container-wasm actually use. So:

- build fast enough here → **green light** to build the faithful browser PoC
  (`c2w --to-js` + COI-served htdocs, reusing `src/core/server.ts`); the
  browser will be at least this fast.
- build too slow here → measure the browser path directly before deciding.

`run.sh` documents the faithful browser steps at the bottom.

### Gotchas encoded in `run.sh` (macOS/arm64, learned the hard way)

- **No macOS c2w binary** — c2w ships linux-only, so we run it inside a
  `docker:cli` container with the Docker socket mounted.
- **Stale in-image git clone** — c2w's embedded Dockerfile clones assets from
  an old repo path (`ktock/container2wasm`) whose `v0.8.4` tag 404s. We clone
  the assets locally and pass `--assets`.
- **Guest clock is skewed** — the emulated guest's `date` (and tool
  self-reports like vite's "built in 11.55s") do NOT match real time. We time
  with the **host wallclock** and subtract a boot-only run.
- **stdin EOF kills the guest** — with stdin closed the guest reads EOF at boot
  and exits 1. Pass c2w's `-no-stdin` and redirect `</dev/null`.

## 3. Is the daemon worth it? (`bench/daemon.mjs`)

```bash
pnpm build
node bench/daemon.mjs ../my-real-project --runs 3
```

Drives the real CLI end to end and compares cold / one-shot `--cache` warm /
daemon warm, then reports the per-build saving and how many builds the daemon's
first run takes to pay back. If the daemon is not faster, it says so.

## 4. What an interception build needs out of `npm install` (`bench/install-shape.mjs`)

`docs/virtual-filesystem.md` open item 8. The interception PoC does not install
anything — it reads `node_modules` off disk — so it does not yet address the
problem wc-exe exists for. Closing that means the host fetching tarballs and
unpacking them into the browser's volume, and §9's stated blocker is **lifecycle
scripts**, which need a process a virtual filesystem cannot provide.

That blocker is the right answer to "reproduce `npm install` faithfully" and
possibly the wrong one to "produce the module graph an interception build
needs". This harness measures the difference:

```bash
node bench/install-shape.mjs <projectDir> [more...]   # needs node_modules present
node bench/install-shape.mjs --json <projectDir>
```

It counts only the scripts npm runs when installing a **published** package —
`preinstall`, `install`, `postinstall`, plus the implicit `node-gyp rebuild` a
`binding.gyp` triggers. `prepare` and `prepublish` are excluded on purpose: they
do not run for a registry tarball, and counting them is what made this fixture
look like it had "3 hooks" when it had one.

### Measured: 10 projects, zero hooks that matter

Nine scaffolded with `npm create vite@latest` (vite 8.2.2) plus the repo's own
vite-5 fixture. `react-app` and `vue-app` add realistic runtime dependencies
(react-router/axios/zod/date-fns/react-query/recharts; pinia/vue-router/
element-plus/axios).

| project          | pkgs | closure | hooks | in closure | node_modules | closure | sendable |
| ---------------- | ---- | ------- | ----- | ---------- | ------------ | ------- | -------- |
| vanilla-ts       | 16   | 0       | 0     | 0          | 53.0 MB      | 0.0 MB  | 0.0 MB   |
| react-ts         | 27   | 3       | 0     | 0          | 80.2 MB      | 7.2 MB  | 7.2 MB   |
| vue-ts           | 48   | 23      | 0     | 0          | 72.4 MB      | 16.1 MB | 10.4 MB  |
| svelte-ts        | 50   | 0       | 0     | 0          | 66.2 MB      | 0.0 MB  | 0.0 MB   |
| preact-ts        | 89   | 1       | 0     | 0          | 70.3 MB      | 1.5 MB  | 0.3 MB   |
| lit-ts           | 22   | 6       | 0     | 0          | 55.8 MB      | 2.8 MB  | 0.7 MB   |
| solid-ts         | 77   | 4       | 0     | 0          | 71.5 MB      | 3.4 MB  | 1.2 MB   |
| react-app        | 112  | 76      | 0     | 0          | 129.5 MB     | 53.5 MB | 33.6 MB  |
| vue-app          | 135  | 118     | 0     | 0          | 135.2 MB     | 79.2 MB | 38.4 MB  |
| sample-react-app | 67   | 5       | 1     | 0          | 44.4 MB      | 4.7 MB  | 4.7 MB   |

`closure` is the runtime dependency closure — the root's `dependencies` and
`optionalDependencies`, transitively, with devDependencies skipped because an
interception build never runs the project's vite. `sendable` applies the same
filter `/api/bulk` uses, so it is what would actually go on the wire.

**Zero lifecycle scripts in any runtime closure, across all ten.** The single
hook found anywhere is `esbuild`'s `postinstall`, in the one vite-5 project, and
it is a devDependency fetching a native binary this pipeline never loads.

**The vite 8 projects have no install hooks at all.** Their native binaries —
`@rolldown/binding-*`, `lightningcss-linux-*`, `@oxlint/*` — arrive as
platform-specific `optionalDependencies` rather than a `postinstall` download.
That shift is why the wall is lower than §9 assumed when it was written.

### But the cost moved rather than vanished

The template projects have tiny closures (0–23 packages, ≤16 MB of a 53–80 MB
`node_modules`). Realistic apps invert that: what you `npm install` yourself is
runtime, so `vue-app`'s closure is 118 of 135 packages and 79.2 MB, filtering to
**38.4 MB**.

That number lands on the mode that has to move it eagerly. `--vfs=memfs` cannot
fetch lazily, and 15.2 MB already costs ~280 ms of the React build; 38 MB is
2.5× that. So install-free interception looks **feasible on correctness** and
moves the problem to **transfer volume** — the same wall `--vfs=memfs` already
hit, larger.

One shape does not have that problem: caching **tarballs**, not extracted trees.
The repo's cacache already does this (§5), and it is the right shape here for
the reason wc-exe exists — antivirus cost is per file, and 40 MB of tarballs is
a few hundred files where the extracted tree is 13,340.

### What this does not measure

- **Ten projects, seven of them scaffolds.** Neither `sharp`-style native
  addons nor monorepos/workspaces appear. Zero hooks here is evidence, not a
  proof.
- **`vanilla-ts` and `svelte-ts` report a closure of 0**, which is literally
  correct and quietly misleading: Svelte's compiler is a devDependency, so a
  build that actually handled `.svelte` files would need more than the runtime
  closure. Read the numbers as _what the PoC as it stands would need_.
- Nothing about whether a host-built tree matches npm's — peer deps,
  `overrides`, platform/optional deps, workspaces. §9's warning stands: that is
  where the cost of this direction actually lives.

## Every harness checks that the build produced something

This is not belt and braces. `npm run build` **exits 0 when its build tool
cannot be spawned at all** — which is what happened when a restored
`node_modules` came back without executable bits. For a long time every
cache-hit run reported a fast, successful, entirely empty build, and these
harnesses recorded the timings without complaint.

So `bench/verify.mjs` counts the output and fails, naming the likely cause, when
there is none. Reintroducing that bug now produces:

```
  boot: 1.68s   mount: 0.14s   install: 0.31s   build: 0.61s
Benchmark failed: The build exited 0 but dist/ does not exist. A build tool that
fails to start still exits 0 under npm — check the build log for EACCES ...
```

Fast, tidy, and entirely fictional. Any number in this file predating that check
should be treated as unverified.

## Recording results

Measured on macOS (M-series, 16 GB), sample-vite-app:

| engine                            | project         | buildMs   | machine / notes                                          |
| --------------------------------- | --------------- | --------- | -------------------------------------------------------- |
| webcontainer                      | sample-vite-app | ~1600     | avg of 3; install ~11.1s, boot ~5.4s                     |
| container2wasm (wasmtime / Bochs) | sample-vite-app | ~56000    | host wallclock: run ~61s − boot ~5.3s; **~35× slower**   |
| container2wasm (browser, --to-js) | sample-vite-app | _pending_ | faithful QEMU-JIT path; expected faster than Bochs above |

**Result:** the Bochs/WASI upper bound is ~35× WebContainer (1.6s → 56s). Even
if the browser QEMU-JIT path is several× faster than Bochs, closing a 35× gap
to parity is unlikely — so for the build burst, WebContainer stays ahead.

Decision (`docs/virtual-filesystem.md` §5, §7):

- **Keep WebContainer** as the build engine; the emulation tax on the CPU-bound
  build is too high to justify switching for performance.
- **Add the OPFS `node_modules` cache** (§5 단기) — that attacks the ~11s
  install, the actual recurring cost, with zero emulation downside.
- Revisit container2wasm only if the driver becomes **WebContainer
  independence** or **non-JS/native toolchains**, not raw build speed — and
  measure the `--to-js` browser path first.
