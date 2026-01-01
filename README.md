# wc-build

WebContainer-based headless build tool for frontend projects.

Security software real-time file scanning causes extreme I/O delays during `npm install`. wc-build bypasses this by running builds inside a browser's WebContainer where files exist only in memory.

## Installation

```bash
npm install -g wc-build
# or
pnpm add -g wc-build
```

## Usage

### Build

Build your project using WebContainer:

```bash
# In your project directory
wc-build

# With options
wc-build build --source ./src --output ./dist
wc-build build --no-install  # Skip npm install
wc-build build --verbose     # Show detailed logs
```

### Dev Server

Start a development server with hot reload:

```bash
wc-build dev

# With custom port
wc-build dev --port 3000
```

Features:

- Proxies WebContainer dev server to localhost
- Watches local files and syncs changes
- Supports HMR (Hot Module Replacement)

### Install Only

Install dependencies without building:

```bash
wc-build install
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Local Environment (with security software)            │
│                                                         │
│  1. Express Server (dynamic port)                      │
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
wc-build [command] [options]

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
  --verbose               Show detailed logs

Dev Options:
  -p, --port <number>     Preview port (default: 5173)
```

## Environment Variables

| Variable      | Description                               |
| ------------- | ----------------------------------------- |
| `CHROME_PATH` | Custom path to Chrome/Chromium executable |

Example:

```bash
CHROME_PATH=/usr/bin/chromium wc-build build
```
