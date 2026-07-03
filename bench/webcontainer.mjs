// WebContainer baseline benchmark.
//
// Measures wall-clock time for `npm install` and `npm run build` of a target
// project running inside StackBlitz's WebContainer (the current wc-exe engine).
// Prints a JSON summary so results can be compared against the container2wasm
// harness in ./container2wasm.
//
// Prerequisites:
//   pnpm build           # builds dist/ (incl. src/runner/dist) that this imports
//   A Chrome/Chromium binary (set CHROME_PATH, or rely on the default lookup)
//
// Usage:
//   node bench/webcontainer.mjs [projectDir] [--runs N]
//   node bench/webcontainer.mjs test/fixtures/sample-vite-app --runs 3

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  startServer,
  WCBrowser,
  listProjectFiles,
  readProjectFileBytes,
} from '../dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const args = { project: 'test/fixtures/sample-vite-app', runs: 1 }
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--runs') {
      args.runs = parseInt(rest[++i], 10)
    } else if (!rest[i].startsWith('--')) {
      args.project = rest[i]
    }
  }
  return args
}

async function timed(label, fn) {
  const start = performance.now()
  const result = await fn()
  const ms = Math.round(performance.now() - start)
  console.log(`  ${label}: ${(ms / 1000).toFixed(2)}s`)
  return { ms, result }
}

async function runOnce(source) {
  const handlers = {
    listFiles: () => listProjectFiles(source),
    readFile: (relPath) => readProjectFileBytes(source, relPath),
  }

  const serverInfo = await startServer(handlers)
  const browser = new WCBrowser({ verbose: false })

  try {
    const boot = await timed('boot', () => browser.launch(serverInfo.url))
    const mount = await timed('mount', () => browser.mountFromServer())

    const install = await timed('install', async () => {
      const code = await browser.runCommand('npm', ['install'])
      if (code !== 0) throw new Error(`npm install exited ${code}`)
    })

    const build = await timed('build', async () => {
      const code = await browser.runCommand('npm', ['run', 'build'])
      if (code !== 0) throw new Error(`npm run build exited ${code}`)
    })

    return {
      bootMs: boot.ms,
      mountMs: mount.ms,
      installMs: install.ms,
      buildMs: build.ms,
      // The number that matters for the container2wasm comparison: the
      // CPU/IO burst of install+build, excluding one-time boot.
      installPlusBuildMs: install.ms + build.ms,
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => serverInfo.server.close(() => resolve()))
  }
}

async function main() {
  const { project, runs } = parseArgs(process.argv)
  const source = path.resolve(repoRoot, project)

  console.log(`\nWebContainer benchmark`)
  console.log(`  project: ${source}`)
  console.log(`  runs:    ${runs}\n`)

  const results = []
  for (let i = 1; i <= runs; i++) {
    console.log(`run ${i}/${runs}`)
    results.push(await runOnce(source))
    console.log()
  }

  const avg = (key) =>
    Math.round(results.reduce((s, r) => s + r[key], 0) / results.length)

  const summary = {
    engine: 'webcontainer',
    project,
    runs,
    perRun: results,
    average: {
      bootMs: avg('bootMs'),
      mountMs: avg('mountMs'),
      installMs: avg('installMs'),
      buildMs: avg('buildMs'),
      installPlusBuildMs: avg('installPlusBuildMs'),
    },
  }

  console.log('=== SUMMARY (webcontainer) ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err.message)
  process.exit(1)
})
