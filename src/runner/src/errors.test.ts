import { describe, expect, it } from 'vitest'
import {
  RunnerError,
  commandFailed,
  mountFailed,
  noBuildOutput,
  runtimeFailure,
  toWire,
  uploadFailed,
} from './errors'
import { fromWire, runtimeStateIsKnown } from '../../core/errors.js'

/**
 * The page and the host are separate bundles that cannot import each other, so
 * the only thing holding them together is the wire format. These tests are the
 * two halves meeting: what this side emits is fed to the host's `fromWire`,
 * which is the check that the contract is one contract and not two.
 */
describe('the runner half of the error contract', () => {
  it('emits a tagged object the host rebuilds as the same failure', () => {
    const wire = toWire(
      commandFailed('pnpm install', {
        exitCode: 1,
        output: 'ERR_PNPM_NO_MATCHING_VERSION',
        truncated: false,
        droppedChars: 0,
      })
    )

    const restored = fromWire(JSON.parse(JSON.stringify(wire)))

    expect(restored._tag).toBe('CommandFailed')
    expect(restored).toMatchObject({ label: 'pnpm install', exitCode: 1 })
    // The output the page captured is what makes this actionable, and it used
    // to stop at this boundary — `installWithCache` threw an exit code alone.
    expect(restored.message).toContain('ERR_PNPM_NO_MATCHING_VERSION')
  })

  it('agrees with the host on which failures leave the runtime usable', () => {
    const known = [
      commandFailed('npm run build', {
        exitCode: 1,
        output: '',
        truncated: false,
        droppedChars: 0,
      }),
      noBuildOutput('/dist', 'nothing there'),
    ]
    const unknown = [
      mountFailed('src/main.ts', 'fetch failed'),
      uploadFailed('assets/app.js', 500, 'upload failed'),
      runtimeFailure('computeCacheKey', 'no lockfile'),
    ]

    for (const error of known) {
      expect(
        runtimeStateIsKnown(fromWire(toWire(error))),
        `${error._tag} should leave the runtime usable`
      ).toBe(true)
    }
    for (const error of unknown) {
      expect(
        runtimeStateIsKnown(fromWire(toWire(error))),
        `${error._tag} should not leave the runtime usable`
      ).toBe(false)
    }
  })

  // A bug in the page bundle is not something the host should have to reason
  // about beyond "do not reuse this runtime".
  it('carries an untagged throw across as an unknown failure', () => {
    expect(toWire(new TypeError('x is not a function'))).toEqual({
      _tag: 'UnknownFailure',
      message: 'x is not a function',
    })
    expect(toWire('a bare string')).toEqual({
      _tag: 'UnknownFailure',
      message: 'a bare string',
    })
    expect(runtimeStateIsKnown(fromWire(toWire(new Error('boom'))))).toBe(false)
  })

  it('stays a real Error, so the page console and its reporter read normally', () => {
    const error = mountFailed('src/main.ts', 'Failed to fetch file')

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(RunnerError)
    expect(error.message).toBe('Failed to fetch file')
    expect(String(error)).toContain('Failed to fetch file')
  })
})
