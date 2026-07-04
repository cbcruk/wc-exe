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
