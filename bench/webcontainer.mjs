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
import {
  startServer,
  RunnerClient,
  listProjectFiles,
  readProjectFileBytes,
} from '../dist/index.js'
import { average, reportBreakdown, reportVerdict } from './report.mjs'
import { assertBuildProduced } from './verify.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// OPFS is scoped per origin (scheme+host+port), so the port must be stable
// across runs or every run starts with an empty cache.
//
// **Not 5199.** That is the product's cache port, and the benchmark used to
// stay clear of the user's day-to-day cache by pointing wc-exe at a Chrome
// profile directory of its own. There is no profile to point at any more — the
// page runs in the user's browser — so the isolation moves to the only other
// axis OPFS is scoped on: a port of our own gives a different origin and
// therefore a different cache. It also means a running daemon on 5199 no
// longer blocks the benchmark.
const CACHE_PORT = Number(process.env.WC_EXE_BENCH_PORT ?? 5299)

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

async function runOnce(source, { cache, wipeCache = false }) {
  const handlers = {
    listFiles: () => listProjectFiles(source),
    readFile: (relPath) => readProjectFileBytes(source, relPath),
  }

  const serverInfo = cache
    ? await startServer(handlers, CACHE_PORT)
    : await startServer(handlers)

  if (cache && serverInfo.port !== CACHE_PORT) {
    await serverInfo.shutdown()
    throw new Error(
      `port ${CACHE_PORT} unavailable (got ${serverInfo.port}); the OPFS cache would not persist`
    )
  }

  const browser = new RunnerClient({ verbose: false, link: serverInfo.link })

  try {
    // The page is opened in the desktop browser, so a run that never starts
    // looks like a silent hang. The URL is the only actionable thing to show.
    console.log(`  waiting for the runner page at ${serverInfo.url} ...`)
    const boot = await timed('boot', () => browser.launch(serverInfo.url))

    // Cleared through the page, not by deleting a directory: OPFS belongs to
    // the browser now. After boot so there is a page to ask, and before the
    // install so the run it precedes really is cold.
    if (wipeCache) {
      const cleared = await browser.clearCache()
      console.log(
        `  cleared cache: ${cleared.removed.length} blob(s), ` +
          `${(cleared.bytes / 1048576).toFixed(1)} MB`
      )
    }

    const mount = await timed('mount', () => browser.mountFromServer())

    let cacheHit = null
    const install = await timed('install', async () => {
      if (!cache) {
        const { exitCode } = await browser.runCommand('npm', ['install'])
        if (exitCode !== 0) throw new Error(`npm install exited ${exitCode}`)
        return
      }
      const result = await browser.installWithCache()
      cacheHit = result.cached
    })

    const build = await timed('build', async () => {
      const { exitCode } = await browser.runCommand('npm', ['run', 'build'])
      if (exitCode !== 0) throw new Error(`npm run build exited ${exitCode}`)
    })

    // Timing a build that produced nothing is worse than not timing it.
    const producedFiles = await assertBuildProduced(browser)

    return {
      bootMs: boot.ms,
      mountMs: mount.ms,
      installMs: install.ms,
      buildMs: build.ms,
      // The number that matters for the container2wasm comparison: the
      // CPU/IO burst of install+build, excluding one-time boot.
      installPlusBuildMs: install.ms + build.ms,
      producedFiles,
      ...(cache ? { cacheHit } : {}),
    }
  } finally {
    await browser.close()
    await serverInfo.shutdown()
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
    console.log(
      `  cache:   OPFS at 127.0.0.1:${CACHE_PORT}` +
        `${keepCache ? ' (kept)' : ' (wiped on run 1)'}`
    )
  }
  console.log()

  const results = []
  for (let i = 1; i <= runs; i++) {
    console.log(`run ${i}/${runs}${cache && i === 1 ? ' (seeding cache)' : ''}`)
    // The wipe happens inside run 1 rather than before the loop, because only
    // a booted page can reach OPFS. Run 1 is the seeding run either way, so
    // clearing at its start is the same cold start as before.
    results.push(
      await runOnce(source, {
        cache,
        wipeCache: cache && !keepCache && i === 1,
      })
    )
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
