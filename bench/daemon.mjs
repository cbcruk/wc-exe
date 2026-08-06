// Is the daemon worth it on YOUR project?
//
// docs/persistent-runner.md was justified by a breakdown taken when the OPFS
// cache was silently restoring an unusable node_modules, so every number it
// rests on is void (§12.1). This re-establishes them, end to end through the
// CLI, on whatever project you point it at.
//
// Every run is checked for actual output. A build that produces nothing is
// fast and meaningless, and that is precisely how the original numbers went
// wrong.
//
// Usage:
//   pnpm build
//   node bench/daemon.mjs ../my-real-project [--runs 3]

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.dirname(import.meta.dirname)
const cli = path.join(repoRoot, 'dist/cli.js')

function parseArgs(argv) {
  const rest = argv.slice(2)
  const runsAt = rest.indexOf('--runs')
  return {
    project:
      rest.find((a) => !a.startsWith('--')) ?? 'test/fixtures/sample-vite-app',
    runs: runsAt >= 0 ? Number(rest[runsAt + 1]) : 3,
  }
}

const { project, runs } = parseArgs(process.argv)
const source = path.resolve(repoRoot, project)

// Isolated, so this never disturbs — or is disturbed by — the user's own
// daemon and cache. A stray daemon holding the shared port silently breaks
// these runs.
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-daemonbench-'))
const env = {
  ...process.env,
  WC_EXE_CACHE_DIR: path.join(work, 'cache'),
  WC_EXE_CACHE_PORT: '5421',
  WC_EXE_DAEMON_IDLE_MS: '900000',
}

function runCli(args) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env,
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) =>
      resolve({ code, out, ms: Math.round(performance.now() - started) })
    )
  })
}

async function countFiles(dir, base = '') {
  let n = 0
  let entries
  try {
    entries = await fs.readdir(path.join(dir, base), { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    n += entry.isDirectory() ? await countFiles(dir, rel) : 1
  }
  return n
}

let outputSeq = 0

/**
 * Times one build and refuses to report it unless files came out.
 *
 * Without the output check this harness would happily record the fastest
 * numbers it has ever seen for builds that produced nothing at all.
 */
async function timedBuild(label, extraArgs) {
  const out = path.join(work, `out-${outputSeq++}`)
  const result = await runCli([
    'build',
    '--source',
    source,
    '--output',
    out,
    ...extraArgs,
  ])

  if (result.code !== 0) {
    throw new Error(
      `${label} failed (exit ${result.code}):\n${result.out.split('\n').slice(-12).join('\n')}`
    )
  }

  const files = await countFiles(out)
  if (files === 0) {
    throw new Error(
      `${label} exited 0 but wrote no files. Timings would be meaningless.`
    )
  }

  console.log(
    `  ${label.padEnd(26)} ${(result.ms / 1000).toFixed(2)}s  (${files} files)`
  )
  return result.ms
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

try {
  console.log(`\nDaemon benchmark`)
  console.log(`  project: ${source}`)
  console.log(`  runs:    ${runs} warm runs per mode\n`)

  console.log('cold (nothing cached, nothing booted)')
  const coldPlain = await timedBuild('one-shot, no cache', [])

  console.log('\none-shot with --cache')
  await timedBuild('seeding the cache', ['--cache'])
  const oneShotWarm = []
  for (let i = 0; i < runs; i++) {
    oneShotWarm.push(await timedBuild(`warm ${i + 1}`, ['--cache']))
  }

  console.log('\ndaemon')
  const daemonCold = await timedBuild('first run (boots)', ['--daemon'])
  const daemonWarm = []
  for (let i = 0; i < runs; i++) {
    daemonWarm.push(await timedBuild(`warm ${i + 1}`, ['--daemon']))
  }

  const oneShotMedian = median(oneShotWarm)
  const daemonMedian = median(daemonWarm)
  const saved = oneShotMedian - daemonMedian

  console.log('\n=== RESULT ===')
  console.log(
    JSON.stringify(
      {
        project,
        coldNoCacheMs: coldPlain,
        daemonColdMs: daemonCold,
        oneShotWarmMs: oneShotWarm,
        daemonWarmMs: daemonWarm,
        oneShotWarmMedianMs: oneShotMedian,
        daemonWarmMedianMs: daemonMedian,
        savedPerBuildMs: saved,
      },
      null,
      2
    )
  )

  const pct = ((saved / oneShotMedian) * 100).toFixed(0)
  console.log(
    `\nWarm build: ${(oneShotMedian / 1000).toFixed(2)}s → ${(daemonMedian / 1000).toFixed(2)}s ` +
      `(${(saved / 1000).toFixed(2)}s saved, ${pct}%)`
  )
  console.log(
    `The daemon pays for itself after ${Math.max(1, Math.ceil(daemonCold / Math.max(saved, 1)))} ` +
      `build(s), given its ${(daemonCold / 1000).toFixed(2)}s first run.`
  )

  if (saved <= 0) {
    console.log(
      '\nThe daemon is NOT faster here. Its remaining justification would be ' +
        'interactive access (docs/persistent-runner.md §8), not speed.'
    )
  }
} finally {
  await runCli(['daemon', 'stop'])
  await fs.rm(work, { recursive: true, force: true })
}
