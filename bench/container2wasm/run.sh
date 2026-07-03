#!/usr/bin/env bash
#
# container2wasm benchmark — measures the emulated `npm run build` burst.
#
# What this measures and why:
#   The go/no-go question for replacing WebContainer with container2wasm is
#   "how much does CPU emulation tax the build?". This converts a Node
#   container (with deps pre-baked) to Wasm and runs `npm run build` inside a
#   WASI runtime, timing the burst. Compare the number against the `buildMs`
#   from `node bench/webcontainer.mjs`.
#
# IMPORTANT — this is a CONSERVATIVE upper bound:
#   The default c2w x86_64 target runs under an interpreter-style emulator in
#   the WASI runtime, which is SLOWER than the QEMU-Wasm JIT (TCG) used by the
#   in-browser path (container2wasm --to-js, and vscode-container-wasm). So if
#   the build finishes in an acceptable time HERE, the real browser engine
#   will be at least as fast. Treat a good result as "green light to build the
#   faithful browser PoC", and a bad result as "measure the browser path
#   before deciding" (see FAITHFUL BROWSER PATH below).
#
# Prerequisites (run on your own machine — ideally the one with the security
# software wc-exe exists to work around):
#   - Docker daemon running
#   - c2w         https://github.com/container2wasm/container2wasm/releases
#   - wasmtime    https://wasmtime.dev  (or set RUNTIME=wasmedge / wamr)
#
# Usage:
#   bench/container2wasm/run.sh [projectDir]
#   PROJECT=../../test/fixtures/sample-vite-app bench/container2wasm/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PROJECT="${1:-${PROJECT:-$REPO_ROOT/test/fixtures/sample-vite-app}}"
RUNTIME="${RUNTIME:-wasmtime}"
IMG="wc-exe-c2w-bench"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }

# --- preflight ------------------------------------------------------------
command -v docker >/dev/null || fail "docker not found"
docker info >/dev/null 2>&1 || fail "docker daemon not reachable (start Docker)"
command -v c2w >/dev/null || fail "c2w not found — install from \
https://github.com/container2wasm/container2wasm/releases"
command -v "$RUNTIME" >/dev/null || fail "$RUNTIME not found — install it or set RUNTIME=<wasi runtime>"
[ -f "$PROJECT/package.json" ] || fail "no package.json in $PROJECT"

echo "container2wasm benchmark"
echo "  project: $PROJECT"
echo "  runtime: $RUNTIME"
echo

# --- stage build context --------------------------------------------------
mkdir -p "$WORK/ctx/app"
# copy the project, excluding heavy/irrelevant dirs
tar -C "$PROJECT" \
  --exclude=node_modules --exclude=.git --exclude=dist \
  -cf - . | tar -C "$WORK/ctx/app" -xf -
cp "$HERE/Dockerfile" "$WORK/ctx/Dockerfile"

# --- build + export image -------------------------------------------------
echo "[1/3] building benchmark image (native npm install)..."
docker build -t "$IMG" "$WORK/ctx" >/dev/null
docker save "$IMG" -o "$WORK/img.tar"

# --- convert to wasm ------------------------------------------------------
echo "[2/3] converting image to wasm with c2w..."
c2w "$WORK/img.tar" "$WORK/out.wasm"

# --- run emulated build ---------------------------------------------------
echo "[3/3] running emulated 'npm run build' under $RUNTIME..."
case "$RUNTIME" in
  wasmtime) OUT="$("$RUNTIME" "$WORK/out.wasm" 2>&1 || true)" ;;
  wasmedge) OUT="$("$RUNTIME" "$WORK/out.wasm" 2>&1 || true)" ;;
  *)        OUT="$("$RUNTIME" "$WORK/out.wasm" 2>&1 || true)" ;;
esac

echo "$OUT" | grep -q C2W_BUILD_MS || {
  echo "$OUT" >&2
  fail "did not find timing marker in guest output"
}

MS="$(echo "$OUT" | grep -o 'C2W_BUILD_MS=[0-9]*' | head -1 | cut -d= -f2)"
STATUS="$(echo "$OUT" | grep -o 'C2W_BUILD_STATUS=[0-9]*' | head -1 | cut -d= -f2)"

echo
echo "=== SUMMARY (container2wasm / $RUNTIME) ==="
printf '{\n  "engine": "container2wasm",\n  "runtime": "%s",\n  "phase": "build-only (deps pre-baked)",\n  "buildStatus": %s,\n  "buildMs": %s,\n  "note": "conservative upper bound vs in-browser QEMU-Wasm JIT"\n}\n' \
  "$RUNTIME" "${STATUS:-null}" "${MS:-null}"

[ "${STATUS:-1}" = "0" ] || fail "guest build failed (status $STATUS); see guest log above"

# --- FAITHFUL BROWSER PATH (manual) --------------------------------------
# The number above uses a WASI runtime. To measure the ACTUAL in-browser
# engine (QEMU-Wasm JIT, matching production and vscode-container-wasm):
#
#   c2w --to-js "$WORK/img.tar" ./htdocs
#   # serve ./htdocs with COOP/COEP headers (SharedArrayBuffer required):
#   #   Cross-Origin-Opener-Policy: same-origin
#   #   Cross-Origin-Embedder-Policy: require-corp
#   # open in Chromium, run the build in the guest terminal, read the timing.
#
# wc-exe already ships a COI-enabled server (src/core/server.ts) that can host
# htdocs, so the browser PoC can reuse that plumbing.
