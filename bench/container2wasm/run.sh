#!/usr/bin/env bash
#
# container2wasm benchmark — measures the emulated `npm run build` burst.
#
# What this measures and why:
#   The go/no-go question for replacing WebContainer with container2wasm is
#   "how much does CPU emulation tax the build?". This converts a Node
#   container (deps pre-baked) to Wasm and runs `npm run build` inside a WASI
#   runtime, timing the burst. Compare against `buildMs` from
#   `node bench/webcontainer.mjs`.
#
# IMPORTANT — this is a CONSERVATIVE upper bound:
#   The default c2w amd64 target runs under Bochs (an interpreter) in the WASI
#   runtime — SLOWER than the QEMU-Wasm JIT (TCG) used by the in-browser path
#   (`c2w --to-js`, and vscode-container-wasm). If the build is acceptable
#   HERE, the browser engine will be at least this fast. If it's too slow,
#   measure the browser path before deciding (see FAITHFUL BROWSER PATH below).
#
# Measurement notes (learned the hard way — see bench/README.md):
#   - The emulated guest's clock is SKEWED vs real time, so in-guest `date` and
#     tool self-reported timings ("built in 11.55s") are NOT reliable. We time
#     with the HOST wallclock and subtract a boot-only run to isolate the build.
#   - The guest reads stdin at boot; with stdin closed it hits EOF and exits 1.
#     We pass c2w's `-no-stdin` and redirect </dev/null.
#   - macOS has no native c2w binary; we run the linux c2w inside a container
#     with the Docker socket mounted. c2w's embedded Dockerfile also git-clones
#     its assets from a stale repo path, so we clone them locally and pass
#     `--assets`.
#
# Prerequisites (run on your own machine — ideally the one with the security
# software wc-exe exists to work around):
#   - Docker daemon running (Docker Desktop / OrbStack / colima)
#   - wasmtime   https://wasmtime.dev   (or set RUNTIME=wasmedge)
#   - git, curl, python3, tar  (for setup + millisecond timing)
# The c2w binary + build assets are downloaded automatically into
# ~/.local/share/c2w on first run (pinned to C2W_VERSION).
#
# Usage:
#   bench/container2wasm/run.sh [projectDir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PROJECT="${1:-${PROJECT:-$REPO_ROOT/test/fixtures/sample-vite-app}}"
RUNTIME="${RUNTIME:-wasmtime}"
C2W_VERSION="${C2W_VERSION:-v0.8.4}"
C2W_HOME="${C2W_HOME:-$HOME/.local/share/c2w}"
IMG="wc-exe-c2w-bench"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# --- preflight ------------------------------------------------------------
command -v docker  >/dev/null || fail "docker not found"
docker info >/dev/null 2>&1   || fail "docker daemon not reachable (start Docker/OrbStack)"
command -v "$RUNTIME" >/dev/null || fail "$RUNTIME not found — install from https://wasmtime.dev"
command -v python3 >/dev/null  || fail "python3 not found (needed for ms timing)"
[ -f "$PROJECT/package.json" ] || fail "no package.json in $PROJECT"

# resolve the docker socket path (OrbStack/Docker Desktop differ)
SOCK="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed 's,^unix://,,')"
[ -S "$SOCK" ] || SOCK=/var/run/docker.sock
[ -S "$SOCK" ] || fail "could not locate docker socket"

# --- one-time setup: c2w binary (linux, run in-container) + build assets ---
ARCH="$(uname -m)"; case "$ARCH" in arm64|aarch64) CARCH=arm64;; x86_64|amd64) CARCH=amd64;; *) fail "unsupported arch $ARCH";; esac
if [ ! -x "$C2W_HOME/c2w" ]; then
  echo "[setup] downloading c2w $C2W_VERSION (linux-$CARCH)..."
  mkdir -p "$C2W_HOME"; TMP="$(mktemp -d)"
  curl -sSL -o "$TMP/c2w.tgz" \
    "https://github.com/container2wasm/container2wasm/releases/download/$C2W_VERSION/container2wasm-$C2W_VERSION-linux-$CARCH.tar.gz"
  tar -C "$TMP" -xzf "$TMP/c2w.tgz"
  find "$TMP" -maxdepth 2 -name c2w -type f -exec cp {} "$C2W_HOME/c2w" \;
  chmod +x "$C2W_HOME/c2w"; rm -rf "$TMP"
fi
if [ ! -f "$C2W_HOME/assets/Dockerfile" ]; then
  echo "[setup] cloning c2w build assets $C2W_VERSION (avoids stale in-image git clone)..."
  rm -rf "$C2W_HOME/assets"
  git clone --depth 1 -b "$C2W_VERSION" https://github.com/container2wasm/container2wasm "$C2W_HOME/assets" >/dev/null 2>&1
fi

echo "container2wasm benchmark"
echo "  project: $PROJECT"
echo "  runtime: $RUNTIME (guest emulator: Bochs / conservative upper bound)"
echo

# --- stage build context --------------------------------------------------
mkdir -p "$WORK/ctx/app"
tar -C "$PROJECT" --exclude=node_modules --exclude=.git --exclude=dist -cf - . \
  | tar -C "$WORK/ctx/app" -xf -
cp "$HERE/Dockerfile" "$WORK/ctx/Dockerfile"

# --- build amd64 image (deps installed natively at build time) ------------
echo "[1/3] building benchmark image (amd64, npm install baked)..."
docker build --platform linux/amd64 -t "$IMG" "$WORK/ctx" >/dev/null 2>&1

# --- convert to wasm (containerized c2w, host socket, local assets) -------
echo "[2/3] converting to wasm via c2w (first run compiles the emulator; slow)..."
docker run --rm \
  -v "$SOCK:/var/run/docker.sock" \
  -v "$C2W_HOME:/opt/c2w:ro" \
  -v "$C2W_HOME/assets:/assets:ro" \
  -v "$WORK:/out" \
  docker:cli /opt/c2w/c2w --assets /assets "$IMG" /out/out.wasm >/dev/null 2>&1
echo "      wasm: $(( $(wc -c < "$WORK/out.wasm") / 1048576 )) MB"

# --- run: host-wallclock, boot-subtracted (guest clock is skewed) ---------
echo "[3/3] measuring under $RUNTIME (host wallclock)..."
run_ms() { local s e; s=$(nowms); "$RUNTIME" "$WORK/out.wasm" -no-stdin "$@" </dev/null >/dev/null 2>&1 || true; e=$(nowms); echo $((e-s)); }

BOOT1=$(run_ms node --version); BOOT2=$(run_ms node --version)
BOOT=$(( BOOT1 < BOOT2 ? BOOT1 : BOOT2 ))     # min boot = least noisy
RUN1=$(run_ms /bin/sh -c 'cd /app && npm run build >/tmp/b.log 2>&1')
RUN2=$(run_ms /bin/sh -c 'cd /app && npm run build >/tmp/b.log 2>&1')
RUN=$(( RUN1 < RUN2 ? RUN1 : RUN2 ))
BUILD=$(( RUN - BOOT ))

echo
echo "=== SUMMARY (container2wasm / $RUNTIME) ==="
printf '{\n  "engine": "container2wasm",\n  "runtime": "%s",\n  "emulator": "bochs-amd64",\n  "measure": "host wallclock, build = run - boot",\n  "bootMs": %s,\n  "buildRunMs": %s,\n  "buildMs": %s,\n  "note": "conservative upper bound vs in-browser QEMU-Wasm JIT"\n}\n' \
  "$RUNTIME" "$BOOT" "$RUN" "$BUILD"

# --- FAITHFUL BROWSER PATH (manual) --------------------------------------
# The number above uses a WASI runtime + Bochs. To measure the ACTUAL
# in-browser engine (QEMU-Wasm JIT, matching production/vscode-container-wasm):
#
#   docker run --rm -v "$SOCK:/var/run/docker.sock" -v "$C2W_HOME:/opt/c2w:ro" \
#     -v "$C2W_HOME/assets:/assets:ro" -v "$PWD/htdocs:/out" \
#     docker:cli /opt/c2w/c2w --assets /assets --to-js wc-exe-c2w-bench /out
#   # serve ./htdocs with COOP/COEP headers (SharedArrayBuffer required):
#   #   Cross-Origin-Opener-Policy: same-origin
#   #   Cross-Origin-Embedder-Policy: require-corp
#   # open in Chromium, run the build in the guest terminal, read the timing.
#
# wc-exe already ships a COI-enabled server (src/core/server.ts) that can host
# htdocs, so the browser PoC can reuse that plumbing.
