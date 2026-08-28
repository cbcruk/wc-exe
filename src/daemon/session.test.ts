import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, type SessionRunner } from './session.js'
import { commandFailure, RunnerTimeout, MountFailed } from '../core/errors.js'
import type { CommandResult, PackageManagerChoice } from '../core/types.js'

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/sample-vite-app'
)

const CHOICE: PackageManagerChoice = {
  manager: 'npm',
  reason: 'no lockfile',
  command: 'npm',
  argsPrefix: [],
  note: 'runtime npm',
}

const OK: CommandResult = {
  exitCode: 0,
  output: '',
  truncated: false,
  droppedChars: 0,
}

/**
 * A runner that succeeds at everything except what the test tells it to fail.
 *
 * A plain object rather than a cast: `SessionRunner` names exactly what a
 * session drives, so if that surface grows this stops compiling instead of
 * quietly no longer standing for the real thing.
 */
function fakeRunner(
  overrides: Partial<SessionRunner> = {}
): SessionRunner & { closed: number } {
  const runner = {
    closed: 0,
    packageManager: () => Promise.resolve(CHOICE),
    installWithCache: () => Promise.resolve({ cached: true, key: 'deadbeef' }),
    runCommand: () => Promise.resolve(OK),
    removePaths: () => Promise.resolve(),
    mountFromServer: () => Promise.resolve(3),
    uploadDist: () => Promise.resolve(7),
    close: function () {
      this.closed++
      return Promise.resolve()
    },
    ...overrides,
  }
  return runner as SessionRunner & { closed: number }
}

function sessionWith(runner: SessionRunner): Session {
  return new Session('test', {
    source: FIXTURE,
    origin: 'http://127.0.0.1:5199',
    open: false,
    attach: () => Promise.resolve(runner),
  })
}

const build = (session: Session): Promise<unknown> =>
  session.build({
    output: path.join(FIXTURE, 'dist'),
    distDir: '/dist',
    noInstall: false,
    verbose: false,
  })

describe('a session that survives its failures', () => {
  /**
   * The bug this whole error vocabulary was built for.
   *
   * A project that does not compile is the most common failure a daemon sees —
   * it is what iterating looks like. The container is untouched by it, so the
   * session must still be reusable; poisoning here meant paying the boot again
   * on every run of the loop the daemon exists to speed up.
   */
  it('is still reusable after the project fails to build', async () => {
    // Fails once, then compiles — the loop the daemon exists for.
    let attempt = 0
    const session = sessionWith(
      fakeRunner({
        runCommand: () => {
          attempt++
          return Promise.resolve(
            attempt === 1
              ? {
                  exitCode: 1,
                  output: 'src/main.ts:3:1 - error TS2304',
                  truncated: false,
                  droppedChars: 0,
                }
              : OK
          )
        },
      })
    )

    await expect(build(session)).rejects.toMatchObject({
      _tag: 'CommandFailed',
    })
    expect(session.poisonedReason).toBeNull()

    // And the fix the user was waiting on lands on the *same* container. Before
    // this, the daemon replaced the session between these two lines and paid
    // the boot again — `reused` would be false here.
    const second = await build(session)
    expect(second).toMatchObject({ reused: true })
  })

  it('reports the failure itself, not a session-is-unusable message', async () => {
    const session = sessionWith(
      fakeRunner({
        runCommand: () =>
          Promise.resolve({
            exitCode: 2,
            output: 'error TS2304: Cannot find name "foo"',
            truncated: false,
            droppedChars: 0,
          }),
      })
    )

    await expect(build(session)).rejects.toThrow('Cannot find name "foo"')
    await expect(build(session)).rejects.toThrow('Cannot find name "foo"')
  })
})

describe('a session that cannot be characterised', () => {
  /**
   * The other side of the same decision. A killed command was cut wherever the
   * clock ran out, so `node_modules` or `dist` may be half-written — and unlike
   * a non-zero exit, nothing here says what state the runtime is in.
   */
  it('is poisoned by a timeout, unlike a non-zero exit', async () => {
    const session = sessionWith(
      fakeRunner({
        runCommand: () =>
          Promise.reject(
            new RunnerTimeout({
              label: 'npm run build',
              timeoutMs: 600_000,
              message: 'Command timed out after 600000ms: npm run build',
            })
          ),
      })
    )

    await expect(build(session)).rejects.toThrow('timed out')
    expect(session.poisonedReason).toContain('RunnerTimeout')
  })

  it('is poisoned when the project could not be pushed in full', async () => {
    const session = sessionWith(
      fakeRunner({
        mountFromServer: () =>
          Promise.reject(
            new MountFailed({
              path: 'src/main.ts',
              message: 'Failed to fetch file src/main.ts: 500',
            })
          ),
      })
    )

    await expect(build(session)).rejects.toThrow('Failed to fetch file')
    expect(session.poisonedReason).toContain('MountFailed')
  })

  // Fail-safe: a failure the vocabulary does not name must still poison, or a
  // failure mode added later would silently start being reused into next build.
  it('is poisoned by a failure it does not recognise', async () => {
    const session = sessionWith(
      fakeRunner({
        uploadDist: () => Promise.reject(new Error('something nobody named')),
      })
    )

    await expect(build(session)).rejects.toThrow('something nobody named')
    expect(session.poisonedReason).toBe('something nobody named')
  })

  it('refuses to build once poisoned', async () => {
    const session = sessionWith(
      fakeRunner({
        uploadDist: () => Promise.reject(new Error('half-written')),
      })
    )

    await expect(build(session)).rejects.toThrow('half-written')
    await expect(build(session)).rejects.toThrow('Session is unusable')
  })
})

describe('what poisoning records', () => {
  // `daemon status` prints one line per session, and a build log is many.
  it('keeps the reason to a single line', async () => {
    const session = sessionWith(
      fakeRunner({
        uploadDist: () =>
          Promise.reject(new Error('first line\nsecond line\nthird line')),
      })
    )

    await expect(build(session)).rejects.toThrow('first line')
    expect(session.poisonedReason).toBe('first line')
  })

  it('leads with the tag, so the kind of failure is visible at a glance', () => {
    expect(
      commandFailure('npm run build', {
        exitCode: 1,
        output: '',
        truncated: false,
        droppedChars: 0,
      })._tag
    ).toBe('CommandFailed')
  })
})
