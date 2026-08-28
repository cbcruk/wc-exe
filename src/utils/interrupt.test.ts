import { describe, expect, it, vi, afterEach } from 'vitest'
import { onInterrupt } from './interrupt.js'

/**
 * Captures the SIGINT listener `onInterrupt` registers, so a test can fire it
 * without sending the process a real signal.
 */
function captureSigint(): { fire: () => void; exits: number[] } {
  let listener: (() => void) | undefined
  const exits: number[] = []

  vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    handler: () => void
  ) => {
    if (event === 'SIGINT') listener = handler
    return process
  }) as typeof process.on)

  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    exits.push(code)
  }) as unknown as typeof process.exit)

  return {
    fire: () => {
      if (!listener) throw new Error('no SIGINT listener was registered')
      listener()
    },
    exits,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('onInterrupt', () => {
  it('runs cleanup and then exits with the given code', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const { fire, exits } = captureSigint()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    onInterrupt({ message: 'cancelled', cleanup, exitCode: 130 })
    fire()
    await vi.waitFor(() => expect(exits).toEqual([130]))

    expect(cleanup).toHaveBeenCalledOnce()
  })

  /**
   * The bug this helper exists for. `process.on('SIGINT', async () => { await
   * cleanup(); process.exit(130) })` skips the exit when cleanup rejects,
   * because an EventEmitter never awaits its listener — so Ctrl-C stops
   * working and nothing says why.
   */
  it('still exits when cleanup rejects, and says what failed', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValue(new Error('server would not close'))
    const { fire, exits } = captureSigint()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    onInterrupt({ message: 'cancelled', cleanup, exitCode: 130 })
    fire()
    await vi.waitFor(() => expect(exits).toEqual([130]))

    expect(error.mock.calls.flat().join(' ')).toContain(
      'server would not close'
    )
  })
})
