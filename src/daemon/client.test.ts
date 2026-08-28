import { describe, expect, it, vi, afterEach } from 'vitest'
import { buildViaDaemon } from './client.js'
import type { DaemonRecord } from './discovery.js'
import { runtimeStateIsKnown } from '../core/errors.js'

const RECORD: DaemonRecord = {
  pid: 1234,
  port: 5199,
  token: 'test-token',
  version: '0.1.1',
  startedAt: new Date().toISOString(),
}

const BODY = {
  source: '/project',
  output: '/project/dist',
  distDir: '/dist',
  noInstall: false,
  fresh: false,
}

/** Answers the next control-plane request with this status and body. */
function daemonAnswers(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a build the daemon ran and could not finish', () => {
  /**
   * The daemon reports its progress line by line, and that log matters most on
   * the run that failed — it is the only thing naming which step produced the
   * failure. It used to reach the CLI as an undeclared `logs` property hung on
   * an `Error`, a contract living entirely outside the types. Both halves of
   * the outcome are values now, so both can carry it.
   */
  it('comes back as a value carrying both the failure and the log', async () => {
    daemonAnswers(500, {
      ok: false,
      logs: ['Reusing booted container', 'Dependencies installed'],
      error: {
        _tag: 'CommandFailed',
        message: 'npm run build failed with exit code 1',
        label: 'npm run build',
        exitCode: 1,
        output: 'src/main.ts:3:1 - error TS2304',
        truncated: false,
        droppedChars: 0,
      },
    })

    const outcome = await buildViaDaemon(RECORD, BODY)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failed build')

    expect(outcome.logs).toEqual([
      'Reusing booted container',
      'Dependencies installed',
    ])
    expect(outcome.error).toMatchObject({
      _tag: 'CommandFailed',
      label: 'npm run build',
      exitCode: 1,
    })
    // Composed from the fields on this side, so it reads the same as a failure
    // raised on the one-shot path.
    expect(outcome.error.message).toContain('error TS2304')
  })

  // Two transports from the page to here, and the tag has to mean the same
  // thing at the end of both.
  it('keeps the tag meaningful after the second hop', async () => {
    daemonAnswers(500, {
      ok: false,
      logs: [],
      error: {
        _tag: 'RunnerTimeout',
        message: 'Command timed out after 600000ms: npm run build',
        label: 'npm run build',
        timeoutMs: 600_000,
      },
    })

    const outcome = await buildViaDaemon(RECORD, BODY)
    if (outcome.ok) throw new Error('expected a failed build')

    expect(runtimeStateIsKnown(outcome.error)).toBe(false)
  })

  it('reports a rejected project as the invalid input it is', async () => {
    daemonAnswers(400, {
      ok: false,
      logs: [],
      error: {
        _tag: 'InvalidProject',
        message: 'No such directory: /nope',
        source: '/nope',
        reason: 'missing',
      },
    })

    const outcome = await buildViaDaemon(RECORD, BODY)
    if (outcome.ok) throw new Error('expected a failed build')

    expect(outcome.error).toMatchObject({
      _tag: 'InvalidProject',
      reason: 'missing',
    })
  })

  it('survives a daemon that failed without saying why', async () => {
    daemonAnswers(500, {})

    const outcome = await buildViaDaemon(RECORD, BODY)
    if (outcome.ok) throw new Error('expected a failed build')

    expect(outcome.logs).toEqual([])
    expect(outcome.error.message).toContain('5199')
  })
})

describe('a build the daemon completed', () => {
  it('comes back whole', async () => {
    daemonAnswers(200, {
      ok: true,
      logs: ['Booted container'],
      reused: false,
      upserted: 12,
      removed: 0,
      written: 7,
    })

    const outcome = await buildViaDaemon(RECORD, BODY)

    expect(outcome).toMatchObject({ ok: true, reused: false, written: 7 })
  })
})

describe('a daemon that is not there', () => {
  // `TypeError: fetch failed` says nothing a user can act on.
  it('throws, rather than looking like a failed build', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    )

    await expect(buildViaDaemon(RECORD, BODY)).rejects.toMatchObject({
      _tag: 'DaemonUnreachable',
      port: 5199,
    })
  })
})
