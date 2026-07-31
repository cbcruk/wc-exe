// WebContainer baseline benchmark.
//
// Measures wall-clock time for `npm install` and `npm run build` of a target
// project running inside StackBlitz's WebContainer (the current wc-exe engine).
// Prints a JSON summary so results can be compared against the container2wasm
// harness in ./container2wasm.
//
// Two modes:
//   (default)  every run cold — plain `npm install`, throwaway Chrome profile.
//              This is the container2wasm comparison baseline.
//   --cache    warm runs — fixed port + persistent profile + the OPFS cache, so
//              run 1 seeds and runs 2..N are cache hits. This is the mode that
//              answers docs/persistent-runner.md Phase 0: on a *warm* run, is
//              boot actually the dominant cost?
//
// Prerequisites:
//   pnpm build           # builds dist/ (incl. src/runner/dist) that this imports
//   A Chrome/Chromium binary (set CHROME_PATH, or rely on the default lookup)
//
// Usage:
//   node bench/webcontainer.mjs [projectDir] [--runs N] [--cache] [--keep-cache]
//   node bench/webcontainer.mjs test/fixtures/sample-vite-app --runs 3
//   node bench/webcontainer.mjs ../my-real-project --cache --runs 4

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  startServer,
  WCBrowser,
  listProjectFiles,
  readProjectFileBytes,
} from '../dist/index.js'
import { average, reportBreakdown, reportVerdict } from './report.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Kept out of the user's real ~/.cache/wc-exe so a benchmark never disturbs —
// or is disturbed by — their day-to-day cache.
const CACHE_ROOT = path.join(os.tmpdir(), 'wc-exe-bench-webcontainer')
const CHROME_PROFILE_DIR = path.join(CACHE_ROOT, 'chrome-profile')
// OPFS is scoped per origin (scheme+host+port), so the port must be stable
// across runs or every run starts with an empty cache.
const CACHE_PORT = Number(process.env.WC_EXE_CACHE_PORT ?? 5199)

function parseArgs(argv) {
  const args = {
    project: 'test/fixtures/sample-vite-app',
    runs: null,
    cache: false,
    keepCache: false,
  }
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--runs') {
      args.runs = parseInt(rest[++i], 10)
    } else if (rest[i] === '--cache') {
      args.cache = true
    } else if (rest[i] === '--keep-cache') {
      args.keepCache = true
    } else if (!rest[i].startsWith('--')) {
      args.project = rest[i]
    }
  }
  // In cache mode run 1 only seeds the cache, so one run measures nothing warm.
  args.runs ??= args.cache ? 2 : 1
  return args
}

async function timed(label, fn) {
  const start = performance.now()
  const result = await fn()
  const ms = Math.round(performance.now() - start)
  console.log(`  ${label}: ${(ms / 1000).toFixed(2)}s`)
  return { ms, result }
}

async function runOnce(source, { cache }) {
  const handlers = {
    listFiles: () => listProjectFiles(source),
    readFile: (relPath) => readProjectFileBytes(source, relPath),
  }

  const serverInfo = cache
    ? await startServer(handlers, CACHE_PORT)
    : await startServer(handlers)

  if (cache && serverInfo.port !== CACHE_PORT) {
    await new Promise((r) => serverInfo.server.close(() => r()))
    throw new Error(
      `port ${CACHE_PORT} unavailable (got ${serverInfo.port}); the OPFS cache would not persist`
    )
  }

  const browser = new WCBrowser({
    verbose: false,
    userDataDir: cache ? CHROME_PROFILE_DIR : undefined,
  })

  try {
    const boot = await timed('boot', () => browser.launch(serverInfo.url))
    const mount = await timed('mount', () => browser.mountFromServer())

    let cacheHit = null
    const install = await timed('install', async () => {
      if (!cache) {
        const code = await browser.runCommand('npm', ['install'])
        if (code !== 0) throw new Error(`npm install exited ${code}`)
        return
      }
      const result = await browser.installWithCache()
      cacheHit = result.cached
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
      ...(cache ? { cacheHit } : {}),
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => serverInfo.server.close(() => resolve()))
  }
}

async function main() {
  const { project, runs, cache, keepCache } = parseArgs(process.argv)
  const source = path.resolve(repoRoot, project)

  console.log(`\nWebContainer benchmark`)
  console.log(`  project: ${source}`)
  console.log(`  runs:    ${runs}`)
  console.log(`  mode:    ${cache ? 'cache (run 1 seeds, 2..N warm)' : 'cold'}`)
  if (cache) {
    console.log(`  cache:   ${CACHE_ROOT}${keepCache ? ' (kept)' : ' (wiped)'}`)
    if (!keepCache) fs.rmSync(CACHE_ROOT, { recursive: true, force: true })
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true })
  }
  console.log()

  const results = []
  for (let i = 1; i <= runs; i++) {
    console.log(`run ${i}/${runs}${cache && i === 1 ? ' (seeding cache)' : ''}`)
    results.push(await runOnce(source, { cache }))
    console.log()
  }

  // In cache mode run 1 pays the full online install; averaging it in would
  // hide the warm number this benchmark exists to produce.
  const warmResults = cache ? results.slice(1) : results
  const summary = {
    engine: 'webcontainer',
    project,
    runs,
    mode: cache ? 'cache' : 'cold',
    perRun: results,
    average: average(results),
    ...(cache && warmResults.length
      ? { warmAverage: average(warmResults) }
      : {}),
  }

  console.log('=== SUMMARY (webcontainer) ===')
  console.log(JSON.stringify(summary, null, 2))

  if (cache) {
    if (!warmResults.length) {
      console.log(
        '\nNo warm run measured — pass --runs 2 or more to get a warm number.'
      )
      return
    }
    if (warmResults.some((r) => r.cacheHit === false)) {
      console.log(
        '\nWARNING: a warm run reported a cache MISS. The persistent-profile/' +
          'fixed-port setup is not holding, so these numbers are not warm.'
      )
    }
    const b = reportBreakdown('warm run', summary.warmAverage)
    reportVerdict(b)
  } else {
    reportBreakdown('cold run', summary.average)
    console.log(
      '\nThis is a COLD breakdown. docs/persistent-runner.md Phase 0 asks about ' +
        'warm runs — re-run with --cache.'
    )
  }
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err.message)
  process.exit(1)
})
