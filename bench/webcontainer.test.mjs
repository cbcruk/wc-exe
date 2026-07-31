import { describe, expect, it } from 'vitest'
import {
  average,
  breakdown,
  verdict,
  BOOT_DOMINANCE_THRESHOLD,
} from './report.mjs'

function run({ boot, mount, install, build }) {
  return {
    bootMs: boot,
    mountMs: mount,
    installMs: install,
    buildMs: build,
    installPlusBuildMs: install + build,
  }
}

describe('average', () => {
  it('averages each phase across runs', () => {
    const avg = average([
      run({ boot: 1000, mount: 100, install: 200, build: 1000 }),
      run({ boot: 3000, mount: 300, install: 400, build: 2000 }),
    ])

    expect(avg).toEqual({
      bootMs: 2000,
      mountMs: 200,
      installMs: 300,
      buildMs: 1500,
      installPlusBuildMs: 1800,
    })
  })

  it('refuses an empty run list rather than reporting NaN', () => {
    expect(() => average([])).toThrow()
  })
})

describe('breakdown', () => {
  // The numbers docs/persistent-runner.md §1 was written from.
  const documented = average([
    run({ boot: 5400, mount: 200, install: 300, build: 1600 }),
  ])

  it('totals every phase and shares sum to 1', () => {
    const b = breakdown(documented)

    expect(b.totalMs).toBe(7500)
    const sum = Object.values(b.share).reduce((s, n) => s + n, 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  it('counts boot and install as amortizable, build as irreducible', () => {
    const b = breakdown(documented)

    expect(b.amortizableMs).toBe(5700)
    expect(b.irreducibleMs).toBe(1600)
    // Mount is replaced by manifest sync, not removed — so it belongs to
    // neither bucket.
    expect(b.replacedBySyncMs).toBe(200)
    expect(b.amortizableMs + b.replacedBySyncMs + b.irreducibleMs).toBe(
      b.totalMs
    )
  })
})

describe('verdict', () => {
  it('says GO when boot dominates a warm run', () => {
    const v = verdict(
      breakdown(
        average([run({ boot: 5400, mount: 200, install: 300, build: 1600 })])
      )
    )

    expect(v.decision).toBe('GO')
    expect(v.bootShare).toBeCloseTo(0.72, 2)
    expect(v.upperBoundMs).toBe(5700)
  })

  // The check that matters: Phase 0 exists to be able to say no. If a project's
  // build dwarfs boot, the daemon buys little and §8 says stop there.
  it('says STOP when the build dwarfs boot', () => {
    const v = verdict(
      breakdown(
        average([run({ boot: 5400, mount: 200, install: 300, build: 60000 })])
      )
    )

    expect(v.decision).toBe('STOP')
    expect(v.bootShare).toBeLessThan(BOOT_DOMINANCE_THRESHOLD)
  })

  it('flips exactly at the threshold, inclusive', () => {
    // boot is exactly 30% of a 10s total.
    const atThreshold = verdict(
      breakdown(
        average([run({ boot: 3000, mount: 0, install: 0, build: 7000 })])
      )
    )
    const belowThreshold = verdict(
      breakdown(
        average([run({ boot: 2999, mount: 0, install: 0, build: 7001 })])
      )
    )

    expect(atThreshold.bootShare).toBeCloseTo(BOOT_DOMINANCE_THRESHOLD, 10)
    expect(atThreshold.decision).toBe('GO')
    expect(belowThreshold.decision).toBe('STOP')
  })
})
