// Does the daemon produce exactly what the one-shot path produces?
//
// This is the check docs/persistent-runner.md §9 puts first, because the risk
// the daemon introduces is not slowness but WRONG OUTPUT. A container that is
// reused across builds carries state, and state that is not accounted for
// shows up as artifacts that no longer match the source.
//
// Byte comparison, not "looks right": a stale chunk left over from a previous
// build is exactly the kind of difference a smoke test would wave through.
//
// Not part of `vitest run` — needs network access to StackBlitz, and a desktop
// session whose default browser runs WebContainer: since wc-exe stopped
// launching a browser, each session's page arrives as a tab someone's desktop
// opens. It will not run on a headless CI box.
//
// What it cannot see, and why `src/core/project-build.test.ts` exists: this
// compares two paths' *artifacts*, so a difference in how the two invoke the
// package manager is invisible while no fixture pins one. That is exactly the
// bug the shared build sequence was extracted to kill.
//
// Usage:
//   pnpm build && node test/integration/daemon-parity.mjs

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

function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Maps every file under `dir` to a digest of its bytes. */
async function fingerprint(dir, base = '') {
  const entries = await fs.readdir(path.join(dir, base), {
    withFileTypes: true,
  })
  const out = {}
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      Object.assign(out, await fingerprint(dir, rel))
    } else {
      const bytes = await fs.readFile(path.join(dir, rel))
      out[rel] = crypto.createHash('sha256').update(bytes).digest('hex')
    }
  }
  return out
}

function diffFingerprints(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys
    .filter((key) => a[key] !== b[key])
    .map((key) => {
      if (!(key in a)) return `${key}: only in daemon build`
      if (!(key in b)) return `${key}: only in one-shot build`
      return `${key}: contents differ`
    })
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-parity-'))
const project = path.join(work, 'project')
const oneShotOut = path.join(work, 'out-oneshot')
const daemonOut = path.join(work, 'out-daemon')
const daemonOut2 = path.join(work, 'out-daemon-2')
const daemonOut3 = path.join(work, 'out-daemon-3')

// A private cache root, so this never disturbs the user's real daemon or cache.
const env = {
  WC_EXE_CACHE_DIR: path.join(work, 'cache'),
  WC_EXE_CACHE_PORT: '5399',
  WC_EXE_DAEMON_IDLE_MS: '600000',
}

try {
  await fs.cp(fixture, project, { recursive: true })
  await fs.rm(path.join(project, 'node_modules'), {
    recursive: true,
    force: true,
  })

  // ---- one-shot baseline ---------------------------------------------------
  const oneShot = await run(
    ['build', '--source', project, '--output', oneShotOut],
    { env }
  )
  check('one-shot build succeeds', oneShot.code === 0, `exit ${oneShot.code}`)
  if (oneShot.code !== 0) console.log(oneShot.stdout + oneShot.stderr)

  // ---- daemon, cold session ------------------------------------------------
  const first = await run(
    ['build', '--daemon', '--source', project, '--output', daemonOut],
    { env }
  )
  check('daemon build succeeds', first.code === 0, `exit ${first.code}`)
  if (first.code !== 0) console.log(first.stdout + first.stderr)
  // Match the session's own log line, not the spinner's prose — ora writes to
  // stderr, so asserting on the spinner would silently test nothing.
  check(
    'first daemon build boots a container',
    /Booted container/.test(first.stdout) && !/Reusing/.test(first.stdout),
    first.stdout
      .split('\n')
      .find((l) => /container/.test(l))
      ?.trim()
  )

  const baseline = await fingerprint(oneShotOut)
  const viaDaemon = await fingerprint(daemonOut)
  const coldDiff = diffFingerprints(baseline, viaDaemon)
  check(
    'daemon output is byte-identical to one-shot',
    coldDiff.length === 0,
    coldDiff.join('; ') || `${Object.keys(baseline).length} files match`
  )

  // ---- daemon, warm session — the case the whole design exists for ---------
  const second = await run(
    ['build', '--daemon', '--source', project, '--output', daemonOut2],
    { env }
  )
  check(
    'second daemon build succeeds',
    second.code === 0,
    `exit ${second.code}`
  )
  check(
    'second build reuses the warm container',
    /Reusing booted container/.test(second.stdout),
    second.stdout
      .split('\n')
      .find((l) => /container/.test(l))
      ?.trim()
  )

  const warmDiff = diffFingerprints(baseline, await fingerprint(daemonOut2))
  check(
    'warm-container output is byte-identical too',
    warmDiff.length === 0,
    warmDiff.join('; ')
  )

  // ---- deletion propagation on a warm container ---------------------------
  //
  // The failure this guards against looks like success: a source file deleted
  // on the host stays resolvable inside a container that was never told, so the
  // build keeps working against code that no longer exists.
  await fs.writeFile(
    path.join(project, 'src/extra.ts'),
    'export const extra = "REMOVED_MARKER"\n'
  )
  const mainPath = path.join(project, 'src/main.ts')
  const originalMain = await fs.readFile(mainPath, 'utf8')
  await fs.writeFile(
    mainPath,
    `import { extra } from './extra'\nconsole.log(extra)\n${originalMain}`
  )

  const withExtra = await run(
    ['build', '--daemon', '--source', project, '--output', daemonOut3],
    { env }
  )
  check('build with the new file succeeds', withExtra.code === 0)
  const withExtraBundle = Object.keys(await fingerprint(daemonOut3))
  const bundleText = await Promise.all(
    withExtraBundle.map((f) => fs.readFile(path.join(daemonOut3, f), 'utf8'))
  )
  check(
    'the new file made it into the bundle',
    bundleText.join('').includes('REMOVED_MARKER')
  )

  // Delete the file but KEEP the import.
  //
  // Deleting the import too would make this prove nothing: an orphaned copy
  // left inside the container is simply tree-shaken away, so the bundle matches
  // either way. An earlier version of this check did exactly that and passed
  // with deletion propagation removed entirely.
  //
  // With the import still there, the build MUST now fail. If it succeeds, the
  // container resolved a module the host no longer has — the false success the
  // whole design is guarding against.
  await fs.rm(path.join(project, 'src/extra.ts'))

  const afterDelete = await run(
    ['build', '--daemon', '--source', project, '--output', daemonOut3],
    { env }
  )
  check(
    'a build that still imports a deleted file FAILS',
    afterDelete.code !== 0,
    afterDelete.code === 0
      ? 'it succeeded — the container is resolving source the host deleted'
      : `exit ${afterDelete.code}`
  )
  check(
    'and it fails because the module cannot be resolved',
    /resolve|not found|extra/i.test(afterDelete.stdout + afterDelete.stderr),
    (afterDelete.stdout + afterDelete.stderr)
      .split('\n')
      .find((l) => /resolve|extra/i.test(l))
      ?.trim()
      ?.slice(0, 100)
  )

  // Now put the source back the way it started and confirm the session
  // recovers to a byte-identical baseline rather than staying poisoned.
  await fs.writeFile(mainPath, originalMain)

  const restored = await run(
    ['build', '--daemon', '--source', project, '--output', daemonOut3],
    { env }
  )
  check('the session recovers after a failed build', restored.code === 0)

  const restoredFiles = Object.keys(await fingerprint(daemonOut3))
  const restoredText = await Promise.all(
    restoredFiles.map((f) => fs.readFile(path.join(daemonOut3, f), 'utf8'))
  )
  check(
    'the deleted file is gone from the bundle',
    !restoredText.join('').includes('REMOVED_MARKER')
  )

  const restoredDiff = diffFingerprints(baseline, await fingerprint(daemonOut3))
  check(
    'output returns to the baseline',
    restoredDiff.length === 0,
    restoredDiff.join('; ')
  )
} finally {
  await run(['daemon', 'stop'], { env })
  await fs.rm(work, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
