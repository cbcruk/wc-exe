import { describe, expect, it, vi } from 'vitest'
import type { Ora } from 'ora'
import { withSpin } from './spinner.js'

function fakeSpinner(): Ora & { succeeded: string[]; failed: string[] } {
  const succeeded: string[] = []
  const failed: string[] = []
  const spinner = {
    succeeded,
    failed,
    start: vi.fn(() => spinner),
    succeed: vi.fn((text?: string) => {
      succeeded.push(text ?? '')
      return spinner
    }),
    fail: vi.fn((text?: string) => {
      failed.push(text ?? '')
      return spinner
    }),
  }
  return spinner as unknown as Ora & { succeeded: string[]; failed: string[] }
}

describe('withSpin', () => {
  it('returns what the work resolves to', async () => {
    const spinner = fakeSpinner()

    const result = await withSpin({
      spinner,
      message: 'working',
      fn: async () => 42,
    })

    expect(result).toBe(42)
  })

  it('re-throws the original error unchanged', async () => {
    const spinner = fakeSpinner()
    const boom = new Error('boom')

    await expect(
      withSpin({
        spinner,
        message: 'working',
        fn: async () => {
          throw boom
        },
      })
    ).rejects.toBe(boom)
  })

  // A spinner owns one terminal line. Command failures now carry the failed
  // command's whole output, so without trimming, the log gets smeared across
  // the progress line and then printed again by whoever reports the error.
  it('puts only the first line of a failure on the spinner', async () => {
    const spinner = fakeSpinner()

    await expect(
      withSpin({
        spinner,
        message: 'building',
        fn: async () => {
          throw new Error('npm run build failed\n\nerror TS2304\nmore detail')
        },
        failMessage: (err) => `Build failed: ${err.message}`,
      })
    ).rejects.toThrow()

    expect(spinner.failed).toEqual(['Build failed: npm run build failed'])
  })

  it('puts only the first line of a success on the spinner', async () => {
    const spinner = fakeSpinner()

    await withSpin({
      spinner,
      message: 'installing',
      fn: async () => 'ok',
      successMessage: 'Installed\nwith trailing detail',
    })

    expect(spinner.succeeded).toEqual(['Installed'])
  })

  it('wraps a thrown non-Error before handing it to failMessage', async () => {
    const spinner = fakeSpinner()

    await expect(
      withSpin({
        spinner,
        message: 'working',
        fn: async () => {
          throw 'a bare string'
        },
        failMessage: (err) => `failed: ${err.message}`,
      })
    ).rejects.toBe('a bare string')

    expect(spinner.failed).toEqual(['failed: a bare string'])
  })
})
