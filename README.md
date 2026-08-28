# wc-exe

WebContainer Executor - Headless build tool for frontend projects.

Security software real-time file scanning causes extreme I/O delays during `npm install`. wc-exe bypasses this by running builds inside a browser's WebContainer where files exist only in memory.

## Requirements

- Node.js 18.0.0 or higher
- A browser that runs WebContainer — Chrome, Edge or Firefox. wc-exe opens a
  tab in whatever your desktop treats as the default browser; if that is not one
  of those, pass `--no-open` and open the printed URL in one that is.

## Installation

```bash
npm install -g wc-exe
# or
pnpm add -g wc-exe
```

## Usage

### Build

Build your project using WebContainer:

```bash
# In your project directory
wc-exe

# With options
wc-exe build --source ./src --output ./dist
wc-exe build --no-install  # Skip npm install
wc-exe build --verbose     # Show detailed logs
```

### Dev Server

Start a development server with hot reload:

```bash
wc-exe dev

# With custom port
wc-exe dev --port 3000
```

Features:

- Proxies WebContainer dev server to localhost
- Watches local files and syncs changes
- Supports HMR (Hot Module Replacement)

### Daemon mode

Booting a WebContainer costs a few seconds on every run. `--daemon` keeps one
booted in the background and reuses it:

```bash
wc-exe build --daemon
```

The daemon starts on first use and shuts itself down after 10 idle minutes.

```bash
wc-exe daemon status    # what is running, and which projects it holds open
wc-exe daemon stop
wc-exe daemon restart
wc-exe build --daemon --fresh   # discard this project's session first
```

Measured on the sample fixture: ~4.2s per warm build without the daemon, ~2.0s
with it. The saving is bounded by boot time, so projects whose build dominates
will see less.

It listens on 127.0.0.1 only, behind a bearer token stored `0600` in
`~/.cache/wc-exe/daemon.json`, and refuses any control request carrying an
`Origin` header — a web page you visit can reach localhost, but cannot drive
your builds.

### Install Only

Install dependencies without building:

```bash
wc-exe install
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Local Environment (with security software)            │
│                                                         │
│  1. Hono Server (dynamic port)                         │
│     └─ COEP/COOP headers for WebContainer              │
│                                                         │
│  2. A tab in your own browser                          │
│     └─ Opened by the CLI, drives itself over SSE       │
│                                                         │
│  3. WebContainer (in browser memory)                   │
│     ├─ Mount source files                              │
│     ├─ npm install (bypasses file scanning!)           │
│     ├─ npm run build                                   │
│     └─ Extract dist/ output                            │
│                                                         │
│  4. Only dist/ folder written to local filesystem      │
└─────────────────────────────────────────────────────────┘
```

## CLI Options

```
wc-exe [command] [options]

Commands:
  build     Build the project (default)
  dev       Start development server
  install   Install dependencies only

Build Options:
  -s, --source <path>     Source directory (default: ".")
  -o, --output <path>     Output directory (default: "./dist")
  -d, --dist-dir <path>   Dist directory in WebContainer (default: "/dist")
  -t, --timeout <ms>      Timeout for npm commands (default: 600000)
  --no-timeout            Disable timeout for npm commands
  --no-install            Skip npm install
  --cache                 Cache node_modules in OPFS; skip install when the lockfile is unchanged
  --verbose               Show detailed logs

Dev Options:
  -p, --port <number>     Preview port (default: 5173)
  --open                  Open browser automatically

Install Options:
  --cache                 Cache node_modules in OPFS; skip install when the lockfile is unchanged
```

## Exit codes

Failures are separated by kind, so a script can tell a red build from a blip
worth retrying without reading stderr:

| Code  | Meaning                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Success.                                                                                                                                                                                                             |
| `1`   | **The project did not build.** A command exited non-zero, or the build reported success and produced no output. Look at the log.                                                                                     |
| `2`   | **The invocation was wrong.** A source path that is not a directory, and the like. Look at the command line.                                                                                                         |
| `3`   | **wc-exe could not do its job.** The runner page never became ready, the daemon would not start or stopped answering, a command was killed on timeout, or wc-exe hit a bug of its own. Retrying is often reasonable. |
| `130` | Interrupted with Ctrl-C.                                                                                                                                                                                             |

## node_modules cache (`--cache`)

`npm install` runs every time and is the slowest step. With `--cache`, the
first run snapshots `node_modules` into the browser's Origin Private File System
(OPFS), keyed by a hash of the lockfile (`package-lock.json` → `pnpm-lock.yaml`
→ `yarn.lock` → `package.json`). Later runs restore the snapshot and skip
install entirely; changing the lockfile invalidates the cache automatically.

Measured on a sample Vite app: cold ~17.5s → warm ~2.7s (install skipped).

To keep OPFS across runs, the cache mode pins the runner to a fixed port
(`5199`) so the origin stays the same — OPFS is scoped per origin, and a random
port would orphan the previous snapshot every run. The snapshot lives in your
browser's storage for that origin, so it persists like any site's data and goes
away if you clear site data. Your project directory is never written to.

## Environment Variables

| Variable            | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `WC_EXE_CACHE_DIR`  | Override the cache directory (default: `~/.cache/wc-exe`)      |
| `WC_EXE_CACHE_PORT` | Override the fixed runner port for `--cache` (default: `5199`) |

Example:

```bash
WC_EXE_CACHE_PORT=6000 wc-exe build --cache
```

### Opening the runner page

By default the CLI hands the runner's URL to your desktop browser. `--no-open`
skips that and prints the URL instead, for when you want to pick the browser, or
watch the page's console, or run against a tab you already have open.
