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
// Usage: node bench/cache-scenarios.mjs

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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const FIXTURE = path.join(repoRoot, 'test/fixtures/sample-vite-app')

// Keep the benchmark's OPFS/profile isolated from the user's real ~/.cache/wc-exe.
const CACHE_ROOT = path.join(os.tmpdir(), 'wc-exe-bench-cache')
const CHROME_PROFILE_DIR = path.join(CACHE_ROOT, 'chrome-profile')
// OPFS is origin-scoped, so the runner port must be stable across runs.
const CACHE_PORT = 5199

// A tiny zero-dependency package: adding it changes the cache key (forcing a
// node_modules MISS) while every pre-existing tarball can still replay from
// cache. That isolates the tarball cache's contribution.
const NEW_DEP = { name: 'ms', version: '2.1.3' }

function wipeCaches() {
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true })
}

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
  if (wipe) wipeCaches()
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

  const browser = new WCBrowser({ userDataDir: CHROME_PROFILE_DIR })
  const logs = []

  try {
    const bootStart = performance.now()
    await browser.launch(serverInfo.url)
    const bootMs = Math.round(performance.now() - bootStart)

    // capture the runner's cache decisions from the page console
    browser.page?.on?.('console', (m) => logs.push(m.text()))

    await browser.mountFromServer()

    const installStart = performance.now()
    const result = await browser.installWithCache()
    const installMs = Math.round(performance.now() - installStart)

    const buildStart = performance.now()
    const code = await browser.runCommand('npm', ['run', 'build'])
    const buildMs = Math.round(performance.now() - buildStart)
    if (code !== 0) throw new Error(`build failed (${code})`)

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

    return { label, bootMs, installMs, buildMs, ...result }
  } finally {
    await browser.close()
    await new Promise((r) => serverInfo.server.close(() => r()))
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

  fs.rmSync(CACHE_ROOT, { recursive: true, force: true })
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err.message)
  process.exit(1)
})
