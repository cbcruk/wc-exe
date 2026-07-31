// Pure reporting logic for bench/webcontainer.mjs.
//
// Split out so it carries no dependency on ../dist — the benchmark itself needs
// a built runner and a Chrome binary, but the arithmetic that turns timings
// into the Phase 0 GO/STOP call is exactly the part that must not be wrong, and
// this way it can be unit-tested (see webcontainer.test.mjs).

/** Phase keys of a single run, in the order they happen. */
export const PHASES = ['bootMs', 'mountMs', 'installMs', 'buildMs']

/**
 * Below this share of a warm run, boot is not the dominant cost and
 * docs/persistent-runner.md §8 says to stop rather than build the daemon.
 */
export const BOOT_DOMINANCE_THRESHOLD = 0.3

/** Averages the phase timings of one or more runs. */
export function average(results) {
  if (!results.length) throw new Error('average() needs at least one run')
  const avg = (key) =>
    Math.round(results.reduce((s, r) => s + r[key], 0) / results.length)
  return {
    bootMs: avg('bootMs'),
    mountMs: avg('mountMs'),
    installMs: avg('installMs'),
    buildMs: avg('buildMs'),
    installPlusBuildMs: avg('installPlusBuildMs'),
  }
}

/**
 * Splits an averaged run into what a persistent runner could and could not
 * remove. See docs/persistent-runner.md §6 for why each phase lands where it
 * does.
 */
export function breakdown(avg) {
  const totalMs = PHASES.reduce((s, k) => s + avg[k], 0)
  return {
    totalMs,
    share: Object.fromEntries(PHASES.map((k) => [k, avg[k] / totalMs])),
    // Boot disappears (the container stays up) and install disappears
    // (node_modules is already in memory, so not even the OPFS restore runs).
    amortizableMs: avg.bootMs + avg.installMs,
    // Mount is not removed, it is *replaced* by manifest-diff sync, whose cost
    // is the open question in docs/persistent-runner.md §10.
    replacedBySyncMs: avg.mountMs,
    // The build burst is the same work either way.
    irreducibleMs: avg.buildMs,
  }
}

/**
 * The Phase 0 decision. `upperBoundMs` is deliberately an upper bound: manifest
 * sync replaces mount at an unmeasured cost, so the real win is smaller.
 */
export function verdict(b) {
  const bootShare = b.share.bootMs
  return {
    decision: bootShare >= BOOT_DOMINANCE_THRESHOLD ? 'GO' : 'STOP',
    bootShare,
    upperBoundMs: b.amortizableMs,
  }
}

const pct = (n) => `${(n * 100).toFixed(1)}%`
const secs = (ms) => `${(ms / 1000).toFixed(2)}s`

/** Prints the phase table and the amortizable/irreducible split. */
export function reportBreakdown(title, avg) {
  const b = breakdown(avg)

  console.log(`\n--- ${title} (total ${secs(b.totalMs)}) ---`)
  for (const key of PHASES) {
    const name = key.replace(/Ms$/, '').padEnd(8)
    console.log(
      `  ${name} ${secs(avg[key]).padStart(7)}  ${pct(b.share[key]).padStart(6)}`
    )
  }
  console.log(
    `  persistent runner would remove: ${secs(b.amortizableMs)} ` +
      `(${pct(b.amortizableMs / b.totalMs)}) = boot + install`
  )
  console.log(
    `  replaced by manifest sync:      ${secs(b.replacedBySyncMs)} (mount; sync cost unmeasured)`
  )
  console.log(
    `  irreducible:                    ${secs(b.irreducibleMs)} (build)`
  )

  return b
}

/** Prints the GO/STOP call docs/persistent-runner.md Phase 0 asks for. */
export function reportVerdict(b) {
  const v = verdict(b)
  console.log('\n=== Phase 0 verdict (docs/persistent-runner.md §8) ===')
  if (v.decision === 'GO') {
    console.log(
      `  GO — boot is ${pct(v.bootShare)} of a warm run ` +
        `(threshold ${pct(BOOT_DOMINANCE_THRESHOLD)}).`
    )
  } else {
    console.log(
      `  STOP — boot is only ${pct(v.bootShare)} of a warm run ` +
        `(threshold ${pct(BOOT_DOMINANCE_THRESHOLD)}). The daemon's upside ` +
        `does not justify the hermeticity risk on this project.`
    )
  }
  console.log(
    `  Upper bound on the win: ${secs(v.upperBoundMs)} per run, ` +
      `MINUS whatever manifest sync costs (currently unmeasured).`
  )
  return v
}
