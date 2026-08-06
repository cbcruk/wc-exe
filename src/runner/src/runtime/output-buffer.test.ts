import { describe, expect, it } from 'vitest'
import { OutputBuffer } from './output-buffer'

describe('OutputBuffer', () => {
  it('keeps everything while under the limit', () => {
    const buffer = new OutputBuffer(100)

    buffer.push('hello ')
    buffer.push('world')

    expect(buffer.text).toBe('hello world')
    expect(buffer.truncated).toBe(false)
    expect(buffer.droppedChars).toBe(0)
  })

  it('ignores empty chunks', () => {
    const buffer = new OutputBuffer(10)

    buffer.push('')
    buffer.push('a')

    expect(buffer.text).toBe('a')
  })

  // The point of keeping the tail: a failing build reports the error last.
  it('keeps the tail, not the head, once over the limit', () => {
    const buffer = new OutputBuffer(5)

    buffer.push('abcdefghij')

    expect(buffer.text).toBe('fghij')
    expect(buffer.truncated).toBe(true)
    expect(buffer.droppedChars).toBe(5)
  })

  it('evicts across chunk boundaries', () => {
    const buffer = new OutputBuffer(5)

    buffer.push('abc')
    buffer.push('def')
    buffer.push('ghi')

    expect(buffer.text).toBe('efghi')
    expect(buffer.text).toHaveLength(5)
    expect(buffer.droppedChars).toBe(4)
  })

  it('drops whole chunks when they fall entirely out of the window', () => {
    const buffer = new OutputBuffer(3)

    buffer.push('aaaa')
    buffer.push('bbbb')

    expect(buffer.text).toBe('bbb')
    expect(buffer.droppedChars).toBe(5)
  })

  // Truncation that is not reported is worse than truncation.
  it('always reports truncation when characters were lost', () => {
    const buffer = new OutputBuffer(4)

    buffer.push('12345')

    expect(buffer.truncated).toBe(true)
    expect(buffer.droppedChars + buffer.text.length).toBe(5)
  })

  it('never exceeds the limit across many pushes', () => {
    const buffer = new OutputBuffer(8)

    for (let i = 0; i < 50; i++) buffer.push(`chunk${i}`)

    // The window is 8 chars and `chunk49` is 7, so the last char of `chunk48`
    // is still in frame — the buffer cuts at the limit, not at chunk edges.
    expect(buffer.text).toHaveLength(8)
    expect(buffer.text).toBe('8chunk49')
  })

  it('rejects a non-positive limit instead of silently keeping nothing', () => {
    expect(() => new OutputBuffer(0)).toThrow(/must be > 0/)
    expect(() => new OutputBuffer(-1)).toThrow(/must be > 0/)
  })
})
