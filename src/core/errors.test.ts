import { describe, expect, it } from 'vitest'
import {
  commandFailure,
  outputTail,
  toWire,
  fromWire,
  isWcError,
  runtimeStateIsKnown,
  exitCodeFor,
  NoBuildOutput,
  RunnerGone,
  RunnerTimeout,
  MountFailed,
  UploadFailed,
  RuntimeFailure,
  UnknownFailure,
  InvalidProject,
  RunnerUnavailable,
  DaemonUnreachable,
  DaemonStartTimeout,
  type WcError,
} from './errors.js'
import type { CommandResult } from './types.js'

const ESC = String.fromCharCode(27)

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 1,
    output: '',
    truncated: false,
    droppedChars: 0,
    ...overrides,
  }
}

describe('outputTail', () => {
  it('strips ANSI escapes', () => {
    expect(outputTail(`${ESC}[31merror${ESC}[39m: boom`)).toBe('error: boom')
  })

  it('drops blank lines', () => {
    expect(outputTail('a\n\n   \nb')).toBe('a\nb')
  })

  it('keeps only the last N lines', () => {
    const output = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')

    expect(outputTail(output, 3)).toBe('line47\nline48\nline49')
  })

  it('returns empty string for output with nothing in it', () => {
    expect(outputTail('')).toBe('')
    expect(outputTail('\n\n  \n')).toBe('')
  })
})

describe('commandFailure', () => {
  // The whole reason for capturing output: an exit code alone is not actionable.
  it('includes the output tail in the message', () => {
    const error = commandFailure(
      'npm run build',
      result({ exitCode: 1, output: 'src/main.ts:3:1 - error TS2304\n' })
    )

    expect(error.message).toContain('npm run build failed with exit code 1')
    expect(error.message).toContain('error TS2304')
  })

  it('still names the command when there was no output', () => {
    const error = commandFailure('npm install', result({ exitCode: 127 }))

    expect(error.message).toBe('npm install failed with exit code 127')
  })

  // Truncation that is not stated reads as the whole log.
  it('says so when output was truncated', () => {
    const error = commandFailure(
      'npm run build',
      result({ output: 'tail', truncated: true, droppedChars: 4096 })
    )

    expect(error.message).toContain('truncated')
    expect(error.message).toContain('4096')
  })

  it('does not mention truncation when nothing was dropped', () => {
    const error = commandFailure('npm run build', result({ output: 'tail' }))

    expect(error.message).not.toContain('truncated')
  })
})

describe('the error vocabulary', () => {
  it('gives commandFailure a tag and keeps the parts it composed from', () => {
    const error = commandFailure(
      'npm run build',
      result({ exitCode: 2, output: 'boom', truncated: true, droppedChars: 9 })
    )

    expect(error._tag).toBe('CommandFailed')
    expect(error.label).toBe('npm run build')
    expect(error.exitCode).toBe(2)
    expect(error.output).toBe('boom')
    expect(error.truncated).toBe(true)
    expect(error.droppedChars).toBe(9)
  })

  it('recognises its own errors and nothing else', () => {
    expect(isWcError(commandFailure('npm install', result()))).toBe(true)
    expect(isWcError(new Error('plain'))).toBe(false)
    expect(isWcError('a string')).toBe(false)
    expect(isWcError(null)).toBe(false)
  })
})

describe('runtimeStateIsKnown', () => {
  // The bug this vocabulary exists for: a project that does not compile leaves
  // the container exactly as it was, so the session is still reusable.
  it('is true for failures that leave the runtime untouched', () => {
    expect(runtimeStateIsKnown(commandFailure('npm run build', result()))).toBe(
      true
    )
    expect(
      runtimeStateIsKnown(
        new NoBuildOutput({ distPath: '/dist', message: 'nothing' })
      )
    ).toBe(true)
    expect(
      runtimeStateIsKnown(new RunnerGone({ reason: 'tab', message: 'gone' }))
    ).toBe(true)
  })

  // A killed command was interrupted at an arbitrary point; an exited one was not.
  it('is false for a timeout, unlike a non-zero exit', () => {
    expect(
      runtimeStateIsKnown(
        new RunnerTimeout({ label: 'npm install', timeoutMs: 5, message: 'x' })
      )
    ).toBe(false)
  })

  // Fail-safe: the default for anything unrecognised must be "do not reuse".
  it('is false for errors it does not know', () => {
    expect(runtimeStateIsKnown(new Error('a bug in our own code'))).toBe(false)
    expect(runtimeStateIsKnown(new UnknownFailure({ message: 'skew' }))).toBe(
      false
    )
    expect(runtimeStateIsKnown(undefined)).toBe(false)
  })
})

describe('exitCodeFor', () => {
  it('separates a broken project from a broken invocation from broken machinery', () => {
    expect(exitCodeFor(commandFailure('npm run build', result()))).toBe(1)
    expect(
      exitCodeFor(new NoBuildOutput({ distPath: '/dist', message: 'x' }))
    ).toBe(1)
    expect(
      exitCodeFor(
        new InvalidProject({ source: '/nope', reason: 'missing', message: 'x' })
      )
    ).toBe(2)
    expect(
      exitCodeFor(new DaemonStartTimeout({ timeoutMs: 20_000, message: 'x' }))
    ).toBe(3)
    expect(exitCodeFor(new Error('a bug in our own code'))).toBe(3)
  })
})

describe('the wire codec', () => {
  // What Phase 1 depends on: nothing the runner knew may be lost on the way to
  // the host, and the host must be able to rebuild the same sentence.
  it('round-trips a command failure without losing anything', () => {
    const original = commandFailure(
      'pnpm run build',
      result({
        exitCode: 1,
        output: 'src/main.ts:3:1 - error TS2304',
        truncated: true,
        droppedChars: 4096,
      })
    )

    const restored = fromWire(JSON.parse(JSON.stringify(toWire(original))))

    expect(restored._tag).toBe('CommandFailed')
    expect(restored.message).toBe(original.message)
    expect(restored).toMatchObject({
      label: 'pnpm run build',
      exitCode: 1,
      output: 'src/main.ts:3:1 - error TS2304',
      truncated: true,
      droppedChars: 4096,
    })
  })

  // A minified page bundle's stack names nothing the host's reader can use, and
  // it is the largest field in every failing build response.
  it('does not put a stack on the wire', () => {
    const wire = toWire(commandFailure('npm install', result()))

    expect(wire).not.toHaveProperty('stack')
    expect(wire).not.toHaveProperty('cause')
  })

  it('carries a plain Error across as an unknown failure', () => {
    expect(toWire(new Error('something else'))).toEqual({
      _tag: 'UnknownFailure',
      message: 'something else',
    })
  })

  // Version skew between the host bundle and the page bundle is a real state,
  // so it gets a name rather than a guess.
  it('keeps the original tag when it does not recognise one', () => {
    const restored = fromWire({
      _tag: 'SomethingNewer',
      message: 'from a newer runner',
    })

    expect(restored._tag).toBe('UnknownFailure')
    expect(restored).toMatchObject({ originalTag: 'SomethingNewer' })
    expect(restored.message).toBe('from a newer runner')
    expect(runtimeStateIsKnown(restored)).toBe(false)
  })

  it('survives a malformed payload', () => {
    expect(fromWire(null)._tag).toBe('UnknownFailure')
    expect(fromWire('not an object')._tag).toBe('UnknownFailure')
    expect(fromWire({})._tag).toBe('UnknownFailure')
    // A known tag with the fields missing must not produce `undefined` holes
    // that only surface much later, inside a message.
    expect(fromWire({ _tag: 'CommandFailed' })).toMatchObject({
      label: 'command',
      exitCode: 1,
      output: '',
      truncated: false,
      droppedChars: 0,
    })
  })

  // Guards the switch in `fromWire`: adding a class and forgetting to handle it
  // there would silently downgrade that failure to UnknownFailure on every hop.
  it('handles every tag the vocabulary defines', () => {
    const samples: WcError[] = [
      commandFailure('npm run build', result()),
      new NoBuildOutput({ distPath: '/dist', message: 'm' }),
      new RunnerGone({ reason: 'r', message: 'm' }),
      new RunnerTimeout({ label: 'l', timeoutMs: 1, message: 'm' }),
      new MountFailed({ path: 'p', message: 'm' }),
      new UploadFailed({ path: 'p', status: 500, message: 'm' }),
      new RuntimeFailure({ operation: 'o', message: 'm' }),
      new UnknownFailure({ message: 'm' }),
      new InvalidProject({ source: 's', reason: 'r', message: 'm' }),
      new RunnerUnavailable({ url: 'u', message: 'm' }),
      new DaemonUnreachable({ port: 1, message: 'm' }),
      new DaemonStartTimeout({ timeoutMs: 1, message: 'm' }),
    ]

    for (const sample of samples) {
      const restored = fromWire(JSON.parse(JSON.stringify(toWire(sample))))
      expect(restored._tag, `${sample._tag} did not round-trip`).toBe(
        sample._tag
      )
      expect(restored.message).toBe(sample.message)
    }
  })
})
