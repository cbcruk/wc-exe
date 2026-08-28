import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeRunnerPage, type FakeRunnerOptions } from '../core/fake-runner.js'

/**
 * The daemon, end to end, with the runtime in memory.
 *
 * Everything between the control-plane request and the runtime is real: the
 * token guard, session routing, `Session`, `runProjectBuild`, `RunnerClient`,
 * the control channel over a socket, and the host routes that serve project
 * files and accept artifacts. Only what happens *inside* the container is fake.
 *
 * This is the tier that was missing. Session behaviour was covered with a
 * hand-written double, which can only prove that `Session` calls the methods
 * the double implements — not that a file deleted on the host actually leaves
 * the runtime, which is the failure mode that looks like success.
 */

// Set before the daemon module is loaded: `CACHE_ROOT` is resolved at import
// time, and the discovery record must not land in the user's real cache
// directory, where it would be mistaken for a running daemon.
const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'wc-exe-daemon-cache-'))
process.env.WC_EXE_CACHE_DIR = cacheDir

const { startDaemon } = await import('./daemon.js')

type Daemon = Awaited<ReturnType<typeof startDaemon>>

let daemon: Daemon | undefined
const pages: FakeRunnerPage[] = []
const tempDirs: string[] = [cacheDir]

afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()))
  await daemon?.close()
  daemon = undefined
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-project-'))
  tempDirs.push(dir)
  for (const [relPath, contents] of Object.entries(files)) {
    const target = path.join(dir, relPath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }
  return dir
}

interface BuildResponse {
  ok: boolean
  logs: string[]
  reused?: boolean
  removed?: number
  written?: number
  error?: { _tag: string; message: string }
}

/** A daemon with no page to serve, since every runner here is a fake one. */
async function start(
  options: { idleMs?: number; maintenanceMs?: number } = {}
): Promise<{ origin: string; headers: HeadersInit }> {
  daemon = await startDaemon({
    port: 0,
    open: false,
    runnerDist: null,
    ...options,
  })
  return {
    origin: `http://127.0.0.1:${daemon.port}`,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      'content-type': 'application/json',
    },
  }
}

/** Session ids the daemon currently holds. */
async function sessionIds(
  origin: string,
  headers: HeadersInit
): Promise<string[]> {
  const res = await fetch(`${origin}/control/health`, { headers })
  const body = (await res.json()) as { sessions: { id: string }[] }
  return body.sessions.map((session) => session.id)
}

/**
 * Runs one build, opening a page for the session if it does not have one yet.
 *
 * The id cannot be known in advance — it is minted inside the request — so the
 * request is started first and the page follows. That is also the real ordering:
 * the daemon prints a URL and waits for someone to open it.
 */
async function build(
  context: { origin: string; headers: HeadersInit },
  body: Record<string, unknown>,
  run?: FakeRunnerOptions['run']
): Promise<BuildResponse> {
  const before = await sessionIds(context.origin, context.headers)
  const pending = fetch(`${context.origin}/control/build`, {
    method: 'POST',
    headers: context.headers,
    body: JSON.stringify(body),
  })

  for (let attempt = 0; attempt < 200; attempt++) {
    const now = await sessionIds(context.origin, context.headers)
    const fresh = now.find((id) => !before.includes(id))
    if (fresh) {
      pages.push(
        await FakeRunnerPage.open({
          url: `${context.origin}/s/${fresh}`,
          run,
        })
      )
      break
    }
    if (now.length === before.length && before.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  return (await (await pending).json()) as BuildResponse
}

/** A build that records what the runtime held when it ran. */
const buildsAManifest: FakeRunnerOptions['run'] = (command, runtime) => {
  if (!command.args.includes('build')) return
  const sources = runtime
    .paths('/src')
    .map((p) => p.slice('/src/'.length))
    .join('\n')
  runtime.write('/dist/sources.txt', sources)
}

describe('a file deleted on the host', () => {
  it('leaves the runtime, and the artifact changes to prove it', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/keep.ts': 'export const keep = 1',
      'src/gone.ts': 'export const gone = 1',
    })
    const output = await project({})
    const context = await start()

    const first = await build(
      context,
      { source, output, distDir: '/dist' },
      buildsAManifest
    )
    expect(first.ok).toBe(true)
    expect(await fs.readFile(path.join(output, 'sources.txt'), 'utf8')).toBe(
      'gone.ts\nkeep.ts'
    )

    await fs.rm(path.join(source, 'src/gone.ts'))

    const second = await build(
      context,
      { source, output, distDir: '/dist' },
      buildsAManifest
    )

    expect(second.ok).toBe(true)
    // The same container: this is the path where a stale file would survive.
    expect(second.reused).toBe(true)
    expect(second.removed).toBe(1)
    // Gone from the runtime, and gone from what the build could see.
    expect(pages[0].fs.has('/src/gone.ts')).toBe(false)
    expect(await fs.readFile(path.join(output, 'sources.txt'), 'utf8')).toBe(
      'keep.ts'
    )
  })
})

describe('a second build into the same container', () => {
  it('applies the edit, adds the new file, and leaves the rest alone', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/a.ts': 'export const a = 1',
      'src/b.ts': 'export const b = 2',
    })
    const output = await project({})
    const context = await start()
    const run: FakeRunnerOptions['run'] = (command, runtime) => {
      if (command.args.includes('build')) {
        runtime.write('/dist/index.html', '<!doctype html>')
      }
    }

    await build(context, { source, output, distDir: '/dist' }, run)

    await fs.writeFile(path.join(source, 'src/a.ts'), 'export const a = 99')
    await fs.mkdir(path.join(source, 'src/nested'), { recursive: true })
    await fs.writeFile(
      path.join(source, 'src/nested/c.ts'),
      'export const c = 3'
    )

    const second = await build(
      context,
      { source, output, distDir: '/dist' },
      run
    )
    expect(second.reused).toBe(true)

    const runtime = pages[0].fs
    expect(runtime.read('/src/a.ts')).toBe('export const a = 99')
    expect(runtime.read('/src/nested/c.ts')).toBe('export const c = 3')
    // The one that matters. A partial sync that took its siblings with it would
    // be the failure that looks like success — the build still runs, against a
    // tree missing a file nobody deleted.
    expect(runtime.read('/src/b.ts')).toBe('export const b = 2')
  })
})

describe('a project that does not compile', () => {
  it('fails with its own tag and leaves the session reusable', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/main.ts': 'export const main = 1',
    })
    const output = await project({})
    const context = await start()

    let compiles = false
    const run: FakeRunnerOptions['run'] = (command, runtime) => {
      if (!command.args.includes('build')) return undefined
      if (!compiles) {
        return {
          exitCode: 1,
          output: "src/main.ts(1,1): error TS2304: Cannot find name 'x'",
        }
      }
      runtime.write('/dist/index.html', '<!doctype html>')
      return undefined
    }

    const failed = await build(
      context,
      { source, output, distDir: '/dist' },
      run
    )
    expect(failed.ok).toBe(false)
    // The tag survives both transports — page to daemon, daemon to caller.
    expect(failed.error?._tag).toBe('CommandFailed')
    expect(failed.error?.message).toContain('error TS2304')

    // Not poisoned: the command exited, so the container is exactly as it was.
    const health = await fetch(`${context.origin}/control/health`, {
      headers: context.headers,
    })
    const body = (await health.json()) as {
      sessions: { poisoned: string | null }[]
    }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].poisoned).toBeNull()

    compiles = true
    const fixed = await build(
      context,
      { source, output, distDir: '/dist' },
      run
    )

    expect(fixed.ok).toBe(true)
    // The point of the daemon: iterating on a broken build must not pay the boot.
    expect(fixed.reused).toBe(true)
    expect(fixed.written).toBe(1)
  })
})

describe('the control plane', () => {
  it('refuses a build with no token', async () => {
    const context = await start()
    const res = await fetch(`${context.origin}/control/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('refuses a request that came from a web page', async () => {
    const context = await start()
    const res = await fetch(`${context.origin}/control/health`, {
      headers: { ...context.headers, origin: 'https://example.com' },
    })
    expect(res.status).toBe(403)
  })
})

describe('the maintenance pass', () => {
  it('reclaims a poisoned session instead of holding it until someone rebuilds', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/main.ts': 'export const main = 1',
    })
    const output = await project({})
    // A long idle window so the pass has nothing else to decide, and a short
    // interval so it is observable without waiting out the real thirty seconds.
    const context = await start({ idleMs: 60_000, maintenanceMs: 20 })

    const failed = await build(
      context,
      { source, output, distDir: '/dist', timeout: 100 },
      (command) =>
        // Never returns. The host kills it and reports `RunnerTimeout`, which
        // is not on the reuse allowlist — a command that was cut at an
        // arbitrary point may have left half a `node_modules` behind.
        command.args.includes('build')
          ? new Promise<never>(() => {})
          : undefined
    )

    expect(failed.ok).toBe(false)
    expect(failed.error?._tag).toBe('RunnerTimeout')

    for (let attempt = 0; attempt < 200; attempt++) {
      const ids = await sessionIds(context.origin, context.headers)
      if (ids.length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // Before the pass existed, this session stayed listed for the daemon's
    // whole life unless the same project happened to be built again.
    expect(await sessionIds(context.origin, context.headers)).toEqual([])
  })
})

/**
 * The cost model, as a test.
 *
 * `docs/ROUNDTRIPS.md` states the budget; this pins it. A protocol change that
 * adds a round trip should fail here and be argued for, rather than being
 * noticed later as "the daemon got slower" with nobody able to say when.
 *
 * The numbers are exact on purpose. A `toBeLessThan` would let cost drift
 * upward one addition at a time, which is precisely how a budget stops meaning
 * anything.
 */
describe('what one build costs', () => {
  it('spends a fixed number of control-channel calls, whatever the project holds', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/a.ts': 'export const a = 1',
      'src/b.ts': 'export const b = 2',
      'src/c.ts': 'export const c = 3',
    })
    const output = await project({})
    const context = await start()

    const first = await build(
      context,
      { source, output, distDir: '/dist' },
      (command, runtime) => {
        if (command.args.includes('build')) {
          runtime.write('/dist/index.html', '<!doctype html>')
        }
      }
    )
    expect(first.ok).toBe(true)

    // Six, and each one is named. `removePaths` appears once — the `clearDist`
    // step — because a first sync deletes nothing.
    expect(pages[0].calls).toEqual([
      'mountFromServer',
      'resolvePackageManager',
      'installWithCache',
      'removePaths',
      'runCommand',
      'uploadDist',
    ])
  })

  it('re-reads only what changed on a second build', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/a.ts': 'export const a = 1',
      'src/b.ts': 'export const b = 2',
      'src/c.ts': 'export const c = 3',
    })
    const output = await project({})
    const context = await start()
    const run: FakeRunnerOptions['run'] = (command, runtime) => {
      if (command.args.includes('build')) {
        runtime.write('/dist/index.html', '<!doctype html>')
      }
    }

    await build(context, { source, output, distDir: '/dist' }, run)
    expect(pages[0].requests).toEqual({ manifest: 1, files: 4, artifacts: 1 })

    // One character, in one of four files.
    await fs.writeFile(path.join(source, 'src/a.ts'), 'export const a = 9')
    const second = await build(
      context,
      { source, output, distDir: '/dist' },
      run
    )
    expect(second.reused).toBe(true)

    // One more file read, for the one file that changed — not four more, and no
    // second manifest. The host already knew the answer (`diffManifests`
    // computed it) and now says so, so the cost of an edit-build loop is
    // proportional to the edit rather than to the project.
    //
    // These numbers used to be `{ manifest: 2, files: 8, artifacts: 2 }`.
    expect(pages[0].requests).toEqual({ manifest: 1, files: 5, artifacts: 2 })
  })
})
