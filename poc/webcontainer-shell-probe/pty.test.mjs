import { describe, expect, it } from 'vitest'
import {
  ANSI_ESCAPE,
  CTRL_C,
  CWD_MARKER,
  CWD_TYPED,
  NEVER_SENT,
  SIGINT_MARKER,
  SIGINT_TYPED,
  STDIN_MARKER,
  STDIN_TYPED,
  attach,
} from './browser/pty.js'

/** A stub process whose output can be driven chunk by chunk. */
function fakeProcess() {
  let push
  const output = new ReadableStream({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk)
    },
  })
  return { proc: { output }, emit: (chunk) => push(chunk) }
}

const PAIRS = [
  ['stdin', STDIN_TYPED, STDIN_MARKER],
  ['sigint', SIGINT_TYPED, SIGINT_MARKER],
  ['cwd', CWD_TYPED, CWD_MARKER],
]

// The probe's single most dangerous failure mode: a pseudoterminal echoes what
// you type, so a naively-chosen marker matches the echo and the check passes
// against a shell that never ran anything. These assert the split survives.
describe('markers distinguish execution from terminal echo', () => {
  for (const [name, typed, marker] of PAIRS) {
    it(`${name}: the typed keystrokes do NOT contain the marker`, () => {
      expect(typed).not.toContain(marker)
    })

    it(`${name}: the executed output DOES contain the marker`, () => {
      // What a shell prints once it actually runs the line: the quote pair
      // collapses away.
      const executed = typed.replace(/"/g, '').replace(/^echo /, '')
      expect(executed).toContain(marker)
    })
  }

  it('the never-sent control appears in no typed string', () => {
    for (const [, typed] of PAIRS) {
      expect(typed).not.toContain(NEVER_SENT)
    }
  })
})

describe('control bytes', () => {
  it('CTRL_C is the single byte a terminal sends for interrupt', () => {
    expect(CTRL_C).toHaveLength(1)
    expect(CTRL_C.charCodeAt(0)).toBe(3)
  })

  it('ANSI_ESCAPE matches a real escape sequence and not plain text', () => {
    expect(ANSI_ESCAPE.test(`${String.fromCharCode(27)}[31mred`)).toBe(true)
    expect(ANSI_ESCAPE.test('just [brackets] in text')).toBe(false)
  })
})

describe('attach', () => {
  it('accumulates a transcript across chunks', async () => {
    const { proc, emit } = fakeProcess()
    const io = attach(proc)

    emit('hello ')
    emit('world')
    await io.waitFor(/hello world/, 1000)

    expect(io.transcript).toBe('hello world')
  })

  it('resolves for a pattern that only completes across a chunk boundary', async () => {
    const { proc, emit } = fakeProcess()
    const io = attach(proc)

    emit('WCPROBE_ST')
    emit('DIN_OK')

    await expect(io.waitFor(new RegExp(STDIN_MARKER), 1000)).resolves.toContain(
      STDIN_MARKER
    )
  })

  it('resolves immediately when the pattern already arrived', async () => {
    const { proc, emit } = fakeProcess()
    const io = attach(proc)

    emit('already here')
    await new Promise((r) => setTimeout(r, 10))

    await expect(io.waitFor(/already here/, 1000)).resolves.toBeTruthy()
  })

  // Without this, a wedged shell would hang the whole probe instead of
  // reporting one failed check.
  it('rejects on timeout when the pattern never arrives', async () => {
    const { proc } = fakeProcess()
    const io = attach(proc)

    await expect(io.waitFor(/never-shows-up/, 50)).rejects.toThrow(/timed out/)
  })
})
