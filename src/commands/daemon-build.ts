import ora from 'ora'
import chalk from 'chalk'
import path from 'node:path'
import { prepareOutputDir } from '../core/file-sync.js'
import { ensureDaemon, buildViaDaemon } from '../daemon/client.js'
import type { BuildOptions } from '../types.js'

/**
 * Builds through the daemon instead of booting a container per run.
 *
 * The observable result must be identical to {@link build} — the daemon exists
 * to skip the boot, not to change what gets produced. `test/integration/
 * daemon-parity.mjs` byte-compares the two paths for exactly that reason.
 */
export async function daemonBuild(
  options: BuildOptions & { fresh?: boolean }
): Promise<void> {
  const {
    source = '.',
    output = './dist',
    distDir = '/dist',
    noInstall = false,
    verbose = false,
    timeout,
    fresh = false,
  } = options

  console.log(chalk.cyan('\n  wc-exe - WebContainer Executor (daemon)\n'))

  const spinner = ora()

  try {
    spinner.start('Connecting to daemon...')
    const record = await ensureDaemon({ verbose })
    spinner.succeed(`Daemon ready on port ${record.port} (pid ${record.pid})`)

    // Emptied here rather than in the daemon: the daemon may be running as a
    // long-lived process with a different working directory, and clearing a
    // caller-supplied output path is the caller's business.
    await prepareOutputDir(path.resolve(output))

    spinner.start('Building...')
    const outcome = await buildViaDaemon(record, {
      source: path.resolve(source),
      output: path.resolve(output),
      distDir,
      noInstall,
      fresh,
      timeout,
    })

    // A failed build is a value here, not an exception, so the log it came with
    // is in hand rather than smuggled on an error object. Printed before the
    // throw for the same reason it always was: without it a failure names a
    // step nobody can place.
    if (!outcome.ok) {
      spinner.fail('Build failed')
      if (outcome.logs.length) {
        console.log(chalk.gray('\n  Progress before the failure:'))
        for (const line of outcome.logs) console.log(chalk.gray(`    ${line}`))
        console.log()
      }
      throw outcome.error
    }

    spinner.succeed(
      outcome.reused
        ? 'Built on a warm container'
        : 'Built on a fresh container'
    )

    for (const line of outcome.logs) {
      console.log(chalk.gray(`  ${line}`))
    }

    console.log(
      chalk.green(`\n  Build successful! `) +
        chalk.gray(`${outcome.written} files → ${output}\n`)
    )
  } catch (error) {
    // Reaching here means the daemon itself failed — unreachable, would not
    // start, or answered with something that was not a build outcome. A build
    // that ran and failed was handled above, with its log.
    if (spinner.isSpinning) spinner.fail('Build failed')
    throw error
  }
}
