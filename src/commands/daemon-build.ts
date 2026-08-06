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
    const result = await buildViaDaemon(record, {
      source: path.resolve(source),
      output: path.resolve(output),
      distDir,
      noInstall,
      fresh,
      timeout,
    })
    spinner.succeed(
      result.reused ? 'Built on a warm container' : 'Built on a fresh container'
    )

    for (const line of result.logs) {
      console.log(chalk.gray(`  ${line}`))
    }

    console.log(
      chalk.green(`\n  Build successful! `) +
        chalk.gray(`${result.written} files → ${output}\n`)
    )
  } catch (error) {
    spinner.fail('Build failed')
    const logs = (error as Error & { logs?: string[] }).logs
    if (logs?.length) {
      console.log(chalk.gray('\n  Progress before the failure:'))
      for (const line of logs) console.log(chalk.gray(`    ${line}`))
      console.log()
    }
    throw error
  }
}
