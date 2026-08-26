// Tarball-cache benchmark — does the npm cacache snapshot actually make a
// lockfile-change MISS cheaper?
//
// The node_modules snapshot cache is all-or-nothing: any lockfile change misses
// and reinstalls. The tarball cache (npm's content-addressed cacache, snapshotted
// to OPFS) is supposed to make that miss cheap by replaying unchanged tarballs
// from cache. This measures whether it does.
//
// Scenarios (run in this order — D wipes, so it must come last):
//   A cold-base      wipe caches, install base project        -> full online install
//   B warm-base      keep caches, same project                -> snapshot HIT (install skipped)
//   C warm-changed   keep caches, project + one new dep       -> snapshot MISS + tarball HIT  <-- the claim
//   D cold-changed   wipe caches, same changed project        -> control: what C costs without the tarball cache
//
// The headline comparison is C vs D: identical work, only difference is whether
// the tarball cache was available.
//
// **Five tabs.** wc-exe opens the runner page in your browser rather than
// launching one, so each scenario opens a tab, plus one to clean up after. They
// are left open — the host does not own them and cannot close them.
//
// The benchmark runs at its own origin (127.0.0.1:5298, override with
// `WC_EXE_BENCH_PORT`) so its OPFS is separate from the cache your real builds
// use at 5199. That separation used to come from a Chrome profile directory of
// our own; there is no profile to own any more, and origin is the other axis
// OPFS is scoped on.
//
// Usage: node bench/cache-scenarios.mjs

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  startServer,
  RunnerClient,
  listProjectFiles,
  readProjectFileBytes,
} from '../dist/index.js'
import { assertBuildProduced } from './verify.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const FIXTURE = path.join(repoRoot, 'test/fixtures/sample-vite-app')

// OPFS is origin-scoped, so the runner port must be stable across runs — and
// **not the product's 5199**. The benchmark used to keep clear of the user's
// real cache by owning a Chrome profile directory; with the page in the user's
// own browser there is no such directory, so isolation moves to the origin. A
// port of our own is a cache of our own.
const CACHE_PORT = Number(process.env.WC_EXE_BENCH_PORT ?? 5298)

// A tiny zero-dependency package: adding it changes the cache key (forcing a
// node_modules MISS) while every pre-existing tarball can still replay from
// cache. That isolates the tarball cache's contribution.
const NEW_DEP = { name: 'ms', version: '2.1.3' }

function makeProjectCopy(withExtraDep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-exe-bench-proj-'))
  fs.cpSync(FIXTURE, dir, { recursive: true })
  // never carry a pre-existing install into the measurement
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })

  if (withExtraDep) {
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkg.dependencies = { ...pkg.dependencies, [NEW_DEP.name]: NEW_DEP.version }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  }

  return dir
}

async function runScenario({ label, wipe, withExtraDep }) {
  const projectDir = makeProjectCopy(withExtraDep)

  const handlers = {
    listFiles: () => listProjectFiles(projectDir),
    readFile: (relPath) => readProjectFileBytes(projectDir, relPath),
  }

  const serverInfo = await startServer(handlers, CACHE_PORT)
  if (serverInfo.port !== CACHE_PORT) {
    throw new Error(
      `port ${CACHE_PORT} unavailable (got ${serverInfo.port}); OPFS would not persist`
    )
  }

  const browser = new RunnerClient({ verbose: false, link: serverInfo.link })

  try {
    const bootStart = performance.now()
    console.log(`  waiting for the runner page at ${serverInfo.url} ...`)
    await browser.launch(serverInfo.url)
    const bootMs = Math.round(performance.now() - bootStart)

    // A cold scenario used to be produced by deleting the Chrome profile
    // directory before the run. Nothing host-side owns that storage now, so
    // the page clears its own — which is why it happens here, after boot,
    // rather than before the server starts.
    //
    if (wipe) {
      const cleared = await browser.clearCache()
      console.log(
        `  (wiped ${cleared.removed.length} blob(s), ` +
          `${(cleared.bytes / 1048576).toFixed(1)} MB)`
      )
    }

    await browser.mountFromServer()

    const installStart = performance.now()
    const result = await browser.installWithCache()
    const installMs = Math.round(performance.now() - installStart)

    // The wipe is checked by its consequence rather than by counting blobs.
    // Counting is the wrong test: scenario A legitimately finds nothing to
    // delete on a fresh origin, so a count would either be vacuous there or
    // wrong everywhere else. What every cold scenario actually needs is that
    // the install MISSED — and a wipe that silently failed would turn A and D
    // into warm runs, making the headline C-vs-D comparison a measurement of
    // two warm runs that still look convincingly different.
    if (wipe && result.cached) {
      throw new Error(
        `${label.trim()}: cache was wiped but the install still HIT — ` +
          `this scenario is not cold, and the comparison it feeds is invalid`
      )
    }

    const buildStart = performance.now()
    const { exitCode } = await browser.runCommand('npm', ['run', 'build'])
    const buildMs = Math.round(performance.now() - buildStart)
    if (exitCode !== 0) throw new Error(`build failed (${exitCode})`)
    // A cache hit that restores an unusable node_modules still exits 0 here.
    const producedFiles = await assertBuildProduced(browser)

    console.log(
      `  ${label}: install ${(installMs / 1000).toFixed(2)}s | build ${(
        buildMs / 1000
      ).toFixed(2)}s | boot ${(bootMs / 1000).toFixed(2)}s | ` +
        `${result.cached ? 'snapshot HIT' : 'snapshot MISS'}` +
        (result.npmCacheRestored ? ' + tarball HIT' : '') +
        (result.npmCacheBytes
          ? ` (cacache ${(result.npmCacheBytes / 1048576).toFixed(1)} MB)`
          : '')
    )

    return { label, bootMs, installMs, buildMs, producedFiles, ...result }
  } finally {
    await browser.close()
    await serverInfo.shutdown()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

/**
 * Leaves the benchmark's origin as it found it.
 *
 * D is the last scenario and it installs, so it leaves a snapshot and a
 * tarball cache behind — roughly 90 MB. That used to disappear with the
 * benchmark's cache directory; now it is browser storage, and only a page at
 * this origin can reach it. Cheap next to a run that takes minutes, and the
 * alternative is silently parking 90 MB in someone's browser.
 */
async function clearLeftovers() {
  const projectDir = makeProjectCopy(false)
  const serverInfo = await startServer(
    {
      listFiles: () => listProjectFiles(projectDir),
      readFile: (relPath) => readProjectFileBytes(projectDir, relPath),
    },
    CACHE_PORT
  )
  const browser = new RunnerClient({ verbose: false, link: serverInfo.link })
  try {
    await browser.launch(serverInfo.url)
    const cleared = await browser.clearCache()
    console.log(
      `\ncleaned up: ${cleared.removed.length} blob(s), ` +
        `${(cleared.bytes / 1048576).toFixed(1)} MB`
    )
  } finally {
    await browser.close()
    await serverInfo.shutdown()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('\nTarball-cache benchmark (sample-vite-app)\n')

  const results = []
  results.push(
    await runScenario({
      label: 'A cold-base   ',
      wipe: true,
      withExtraDep: false,
    })
  )
  results.push(
    await runScenario({
      label: 'B warm-base   ',
      wipe: false,
      withExtraDep: false,
    })
  )
  results.push(
    await runScenario({
      label: 'C warm-changed',
      wipe: false,
      withExtraDep: true,
    })
  )
  results.push(
    await runScenario({
      label: 'D cold-changed',
      wipe: true,
      withExtraDep: true,
    })
  )

  const byLabel = Object.fromEntries(results.map((r) => [r.label.trim(), r]))
  const c = byLabel['C warm-changed']
  const d = byLabel['D cold-changed']

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify({ scenarios: results }, null, 2))

  if (c && d) {
    const speedup = d.installMs / c.installMs
    const saved = ((d.installMs - c.installMs) / 1000).toFixed(2)
    console.log(
      `\nHeadline (C vs D — same work, tarball cache present vs not):\n` +
        `  install ${(d.installMs / 1000).toFixed(2)}s -> ${(
          c.installMs / 1000
        ).toFixed(2)}s  (${speedup.toFixed(2)}x, ${saved}s saved)`
    )
    console.log(
      c.npmCacheRestored
        ? '  tarball cache participated in C as intended.'
        : '  WARNING: C did not restore the tarball cache — result is not valid.'
    )
  }

  await clearLeftovers()
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err.message)
  process.exit(1)
})
