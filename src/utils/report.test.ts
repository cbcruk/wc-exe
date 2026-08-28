import { describe, expect, it, vi, afterEach } from 'vitest'
import { errorMessage, reportFailure } from './report.js'
import {
  commandFailure,
  InvalidProject,
  DaemonStartTimeout,
  NoBuildOutput,
} from '../core/errors.js'

/** Runs `reportFailure` without ending the test process. */
function report(error: unknown): { code: number | undefined; output: string } {
  let code: number | undefined
  const lines: string[] = []

  vi.spyOn(process, 'exit').mockImplementation(((exitCode: number) => {
    code = exitCode
    // `reportFailure` returns `never`, so nothing runs after this in practice;
    // throwing keeps that true here too, instead of letting the test fall
    // through a line that the real process would never reach.
    throw new Error('exited')
  }) as unknown as typeof process.exit)

  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })

  try {
    reportFailure('Build failed', error)
  } catch {
    /* the stubbed exit */
  }

  return { code, output: lines.join('\n') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reportFailure', () => {
  /**
   * Every command used to exit `1`. To anything reading the exit status, "your
   * project does not compile" and "the daemon would not start" were the same
   * event — in CI, the difference between a red build to look at and a blip to
   * retry.
   */
  it('exits 1 when the project is what failed', () => {
    expect(
      report(
        commandFailure('npm run build', {
          exitCode: 1,
          output: 'error TS2304',
          truncated: false,
          droppedChars: 0,
        })
      ).code
    ).toBe(1)

    expect(
      report(new NoBuildOutput({ distPath: '/dist', message: 'nothing' })).code
    ).toBe(1)
  })

  it('exits 2 when the invocation was wrong', () => {
    expect(
      report(
        new InvalidProject({
          source: '/nope',
          reason: 'missing',
          message: 'No such directory: /nope',
        })
      ).code
    ).toBe(2)
  })

  it('exits 3 when wc-exe could not do its job', () => {
    expect(
      report(
        new DaemonStartTimeout({ timeoutMs: 20_000, message: 'never came up' })
      ).code
    ).toBe(3)
  })

  // A bug in this code is not the project's fault, and must not be reported as
  // though the user's build were broken.
  it('exits 3 for a failure that is not one of ours', () => {
    expect(report(new TypeError('x is not a function')).code).toBe(3)
  })

  it('prints the failure, not just its category', () => {
    const { output } = report(
      commandFailure('npm run build', {
        exitCode: 1,
        output: 'src/main.ts:3:1 - error TS2304',
        truncated: false,
        droppedChars: 0,
      })
    )

    expect(output).toContain('Build failed')
    expect(output).toContain('error TS2304')
  })
})

describe('errorMessage', () => {
  // `(error as Error).message` on a non-Error yields undefined, which prints as
  // the word "undefined" exactly where the cause should be.
  it('says something useful for anything throwable', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('a bare string')).toBe('a bare string')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage({ code: 500 })).toBe('[object Object]')
  })
})
