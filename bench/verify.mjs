// Did the build actually produce anything?
//
// Every harness here used to decide that from `npm run build`'s exit code
// alone, and that is not enough: a build tool that cannot be spawned prints its
// error and npm still exits 0. That is not hypothetical — a restored
// `node_modules` lost its executable bits, so for a long time every cache-hit
// run reported a fast, successful, entirely empty build, and the benchmarks
// dutifully recorded the timings.
//
// A benchmark that cannot tell a working build from a no-op one is worse than
// no benchmark, because it produces numbers people then reason from.

/** Counts files under `distDir` inside the runtime, recursively. */
export async function countBuildOutput(browser, distDir = 'dist') {
  const script = `
    const fs = require('fs')
    const root = process.env.WCBENCH_DIST
    let n = 0
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = p + '/' + e.name
        if (e.isDirectory()) walk(f)
        else n++
      }
    }
    try { walk(root) } catch { n = -1 }
    console.log('WCBENCH_FILES=' + n)
  `

  const result = await browser.runCommand('node', ['-e', script], {
    env: { WCBENCH_DIST: distDir },
  })

  const match = /WCBENCH_FILES=(-?\d+)/.exec(result.output)
  if (!match) {
    throw new Error(
      `Could not count build output; the probe printed: ${JSON.stringify(
        result.output.slice(-200)
      )}`
    )
  }
  return Number(match[1])
}

/**
 * Fails unless the build left files behind.
 *
 * @throws Naming the likely cause, because "0 files" on its own sends people
 *   looking at the wrong thing.
 */
export async function assertBuildProduced(browser, distDir = 'dist') {
  const count = await countBuildOutput(browser, distDir)

  if (count < 0) {
    throw new Error(
      `The build exited 0 but ${distDir}/ does not exist. A build tool that ` +
        'fails to start still exits 0 under npm — check the build log for ' +
        'EACCES or "command not found". Timings from this run are meaningless.'
    )
  }
  if (count === 0) {
    throw new Error(
      `The build exited 0 but ${distDir}/ is empty. Timings from this run are ` +
        'meaningless.'
    )
  }

  return count
}
