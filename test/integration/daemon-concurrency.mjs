// Can the daemon hold more than one project open at once?
//
// docs/persistent-runner.md §3 says "N sessions = N pages", and the whole point
// of a long-lived daemon is that a developer working across two repos pays the
// boot cost once each rather than on every switch. This exercises that.
//
// Usage:
//   pnpm build && node test/integration/daemon-concurrency.mjs

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.dirname(path.dirname(import.meta.dirname))
const cli = path.join(repoRoot, 'dist/cli.js')
const fixture = path.join(repoRoot, 'test/fixtures/sample-vite-app')

let failures = 0
const check = (name, ok, detail) => {
  console.log(
    `[${ok ? ' OK ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`
  )
  if (!ok) failures++
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function fingerprint(dir, base = '') {
  const entries = await fs.readdir(path.join(dir, base), {
    withFileTypes: true,
  })
  const out = {}
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, await fingerprint(dir, rel))
    else {
      const bytes = await fs.readFile(path.join(dir, rel))
      out[rel] = crypto.createHash('sha256').update(bytes).digest('hex')
    }
  }
  return out
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-conc-'))
const env = {
  WC_EXE_CACHE_DIR: path.join(work, 'cache'),
  WC_EXE_CACHE_PORT: '5417',
  WC_EXE_DAEMON_IDLE_MS: '600000',
}

/** Two projects that differ in a way visible in the built output. */
async function makeProject(name, marker) {
  const dir = path.join(work, name)
  await fs.cp(fixture, dir, { recursive: true })
  await fs.rm(path.join(dir, 'node_modules'), { recursive: true, force: true })
  const mainPath = path.join(dir, 'src/main.ts')
  const original = await fs.readFile(mainPath, 'utf8')
  await fs.writeFile(mainPath, `console.log("${marker}")\n${original}`)
  return dir
}

try {
  const alpha = await makeProject('alpha', 'MARKER_ALPHA')
  const beta = await makeProject('beta', 'MARKER_BETA')
  const outAlpha = path.join(work, 'out-alpha')
  const outBeta = path.join(work, 'out-beta')

  // Sequential first: two projects, one after the other. Even without any
  // concurrency this needs two live sessions, since the first is kept open.
  const a1 = await run(
    ['build', '--daemon', '--source', alpha, '--output', outAlpha],
    env
  )
  check('first project builds', a1.code === 0, `exit ${a1.code}`)

  const b1 = await run(
    ['build', '--daemon', '--source', beta, '--output', outBeta],
    env
  )
  check(
    'second project builds while the first session is still open',
    b1.code === 0,
    b1.code === 0
      ? undefined
      : (b1.stdout + b1.stderr)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-3)
          .join(' | ')
  )

  const status = await run(['daemon', 'status'], env)
  check(
    'the daemon reports two open sessions',
    (status.stdout.match(/\[ok\]/g) ?? []).length === 2,
    status.stdout
      .split('\n')
      .find((l) => /sessions/.test(l))
      ?.trim()
  )

  // Each project must get its own output, not the other's.
  const alphaText = Object.keys(await fingerprint(outAlpha))
  const alphaBundle = (
    await Promise.all(
      alphaText.map((f) => fs.readFile(path.join(outAlpha, f), 'utf8'))
    )
  ).join('')
  const betaFiles = Object.keys(await fingerprint(outBeta))
  const betaBundle = (
    await Promise.all(
      betaFiles.map((f) => fs.readFile(path.join(outBeta, f), 'utf8'))
    )
  ).join('')

  check(
    'the first project got its own marker',
    alphaBundle.includes('MARKER_ALPHA') && !alphaBundle.includes('MARKER_BETA')
  )
  check(
    'the second project got its own marker',
    betaBundle.includes('MARKER_BETA') && !betaBundle.includes('MARKER_ALPHA')
  )

  // Now genuinely at the same time. Two sessions must not fight over the
  // browser, the profile directory, or each other's files.
  const outAlpha2 = path.join(work, 'out-alpha-2')
  const outBeta2 = path.join(work, 'out-beta-2')
  const [a2, b2] = await Promise.all([
    run(['build', '--daemon', '--source', alpha, '--output', outAlpha2], env),
    run(['build', '--daemon', '--source', beta, '--output', outBeta2], env),
  ])

  check(
    'both projects build concurrently',
    a2.code === 0 && b2.code === 0,
    `alpha exit ${a2.code}, beta exit ${b2.code}`
  )

  if (a2.code === 0 && b2.code === 0) {
    const sameAlpha = diff(
      await fingerprint(outAlpha),
      await fingerprint(outAlpha2)
    )
    const sameBeta = diff(
      await fingerprint(outBeta),
      await fingerprint(outBeta2)
    )
    check(
      'concurrent output matches the sequential output',
      sameAlpha.length === 0 && sameBeta.length === 0,
      [...sameAlpha, ...sameBeta].join('; ')
    )
  }
  // Evicting one session must not disturb the other. The sessions share a
  // browser, so a close() that shut the browser down instead of just its own
  // page would take every other project's page with it.
  const outAlpha3 = path.join(work, 'out-alpha-3')
  const alphaFresh = await run(
    ['build', '--daemon', '--fresh', '--source', alpha, '--output', outAlpha3],
    env
  )
  check(
    'discarding one session rebuilds it',
    alphaFresh.code === 0,
    `exit ${alphaFresh.code}`
  )
  check(
    'and it really was discarded, not reused',
    /Booted container/.test(alphaFresh.stdout) &&
      !/Reusing/.test(alphaFresh.stdout)
  )

  const outBeta3 = path.join(work, 'out-beta-3')
  const betaAfter = await run(
    ['build', '--daemon', '--source', beta, '--output', outBeta3],
    env
  )
  check(
    'the other session survives that eviction',
    betaAfter.code === 0 && /Reusing booted container/.test(betaAfter.stdout),
    betaAfter.stdout
      .split('\n')
      .find((l) => /container/.test(l))
      ?.trim() ?? `exit ${betaAfter.code}`
  )
} finally {
  await run(['daemon', 'stop'], env)
  await fs.rm(work, { recursive: true, force: true })
}

function diff(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.filter((k) => a[k] !== b[k])
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
