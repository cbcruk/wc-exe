import { describe, expect, it } from 'vitest'
import { commandFailure, outputTail } from './command-error.js'
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
