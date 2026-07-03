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

Prereqs (all run locally): Docker daemon, [`c2w`](https://github.com/container2wasm/container2wasm/releases),
and a WASI runtime ([`wasmtime`](https://wasmtime.dev), or `RUNTIME=wasmedge`).
It bakes `node_modules` natively, converts the image to Wasm, and times
`npm run build` inside the runtime.

**This is a conservative upper bound.** The default WASI-runtime emulator is
slower than the in-browser QEMU-Wasm JIT (TCG) that production and
vscode-container-wasm actually use. So:

- build fast enough here → **green light** to build the faithful browser PoC
  (`c2w --to-js` + COI-served htdocs, reusing `src/core/server.ts`); the
  browser will be at least this fast.
- build too slow here → measure the browser path directly before deciding.

`run.sh` documents the faithful browser steps at the bottom.

## Recording results

| engine                            | project         | buildMs | machine / notes                             |
| --------------------------------- | --------------- | ------- | ------------------------------------------- |
| webcontainer                      | sample-vite-app | ~1596   | macOS, avg of 3; install ~11.1s, boot ~5.4s |
| container2wasm (wasmtime)         | sample-vite-app | \_      | conservative upper bound                    |
| container2wasm (browser, --to-js) | sample-vite-app | \_      | faithful                                    |

Decision rule (`docs/virtual-filesystem.md` §5, §7):

- acceptable → pursue container2wasm for WebContainer independence.
- too slow → keep WebContainer, add the OPFS `node_modules` cache instead.
