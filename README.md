# wc-exe

WebContainer Executor - Headless build tool for frontend projects.

Security software real-time file scanning causes extreme I/O delays during `npm install`. wc-exe bypasses this by running builds inside a browser's WebContainer where files exist only in memory.

## Requirements

- Node.js 18.0.0 or higher
- Chrome or Chromium browser (for Puppeteer)

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
│  2. Puppeteer (Headless Chrome)                        │
│     └─ Runs WebContainer in browser                    │
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

## node_modules cache (`--cache`)

`npm install` runs every time and is the slowest step. With `--cache`, the
first run snapshots `node_modules` into the browser's Origin Private File System
(OPFS), keyed by a hash of the lockfile (`package-lock.json` → `pnpm-lock.yaml`
→ `yarn.lock` → `package.json`). Later runs restore the snapshot and skip
install entirely; changing the lockfile invalidates the cache automatically.

Measured on a sample Vite app: cold ~17.5s → warm ~2.7s (install skipped).

To keep OPFS across runs, the cache mode pins the runner to a fixed port
(`5199`, so the origin is stable) and uses a persistent Chrome profile under
`~/.cache/wc-exe/`. Your project directory is never written to; the cache lives
as an opaque blob inside that profile.

## Environment Variables

| Variable            | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `CHROME_PATH`       | Custom path to Chrome/Chromium executable                      |
| `WC_EXE_CACHE_DIR`  | Override the cache directory (default: `~/.cache/wc-exe`)      |
| `WC_EXE_CACHE_PORT` | Override the fixed runner port for `--cache` (default: `5199`) |

Example:

```bash
CHROME_PATH=/usr/bin/chromium wc-exe build --cache
```
