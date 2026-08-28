import ora from 'ora'
import chalk from 'chalk'
import {
  startServer,
  startServerWithFallback,
  type ServerInfo,
} from '../core/server.js'
import { RunnerClient } from '../core/runner-client.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  prepareOutputDir,
  writeDistFile,
} from '../core/file-sync.js'
import { CACHE_PORT, ensureCacheDirs } from '../core/cache.js'
import { runProjectBuild } from '../core/project-build.js'
import { withSpin } from '../utils/spinner.js'
import { onInterrupt } from '../utils/interrupt.js'
import { errorMessage } from '../utils/report.js'
import type { ServerHandlers } from '../core/types.js'
import type { BuildOptions } from '../types.js'

/**
 * Builds a project inside the browser runtime and writes the output to disk.
 *
 * Serves the project over a local server, opens the runner page in the desktop
 * browser, mounts the files, installs dependencies, runs `npm run build`, then
 * copies the artifacts back out.
 *
 * @param options See {@link BuildOptions}.
 * @throws If any step fails. The server and the link are always torn down
 *   first; the tab is the user's to close.
 * @remarks Calls `process.exit(0)` on success, so it never resolves — this is
 *   the CLI entry point, not a reusable library call.
 */
export async function build(options: BuildOptions): Promise<void> {
  const {
    source = '.',
    output = './dist',
    distDir = '/dist',
    noInstall = false,
    cache = false,
    verbose = false,
    open = true,
    timeout,
  } = options

  console.log(chalk.cyan('\n  wc-exe - WebContainer Executor\n'))

  if (cache) ensureCacheDirs()

  const spinner = ora()

  let serverInfo: ServerInfo | undefined
  let browser: RunnerClient | null = null

  const cleanup = async (): Promise<void> => {
    spinner.stop()
    await browser?.close()
    await serverInfo?.shutdown()
  }

  onInterrupt({
    message: chalk.yellow('\n\n  Build cancelled.\n'),
    cleanup,
    exitCode: 130,
  })

  const handlers: ServerHandlers = {
    listFiles: () => listProjectFiles(source),
    readFile: (relPath) => readProjectFileBytes(source, relPath),
    writeDistFile: (relPath, data) => writeDistFile(output, relPath, data),
  }

  try {
    serverInfo = await withSpin({
      spinner,
      message: 'Starting local server...',
      fn: async () => {
        if (!cache) return startServer(handlers)
        const { info, stablePort } = await startServerWithFallback(
          handlers,
          CACHE_PORT
        )
        if (!stablePort) {
          console.log(
            chalk.yellow(
              `  Port ${CACHE_PORT} busy — cache disabled for this run.`
            )
          )
        }
        return info
      },
      successMessage: (info) => `Server started on ${info.url}`,
      failMessage: 'Failed to start server',
    })

    const cacheStable = cache && serverInfo.port === CACHE_PORT

    browser = new RunnerClient({ verbose, link: serverInfo.link })
    await withSpin({
      spinner,
      // The URL is in the message rather than only in a failure, because it is
      // the fallback: if the desktop opener does not work, or the default
      // browser cannot run a WebContainer, the user needs to see where to point
      // one *while* the wait is happening, not after it times out.
      message: `Waiting for the runner page at ${serverInfo.url} ...`,
      fn: () => browser!.launch(serverInfo!.url, { open }),
      successMessage: 'WebContainer booted',
      failMessage: 'The runner page never reported ready',
    })

    const result = await runProjectBuild(browser, {
      distDir,
      noInstall,
      // Only with a stable origin. Without it OPFS starts empty every run, so
      // the snapshot would be written for a run that can never find it.
      cache: cacheStable,
      timeout,
      // A fresh container per run holds no previous output to clear.
      clearDist: false,
      mount: async () => ({
        upserted: await browser!.mountFromServer(),
        removed: 0,
      }),
      // After the build, not before: a failed build must leave whatever was in
      // the output directory alone.
      prepareOutput: () => prepareOutputDir(output),
      onProgress: ({ phase, message }) =>
        phase === 'start' ? spinner.start(message) : spinner.succeed(message),
    })

    if (verbose) {
      const invocation = [
        result.choice.command,
        ...result.choice.argsPrefix,
        'run',
        'build',
      ].join(' ')
      console.log(chalk.gray(`  build command: ${invocation}`))
    }

    console.log(
      chalk.green(`\n  Build successful! `) +
        chalk.gray(`${result.written} files → ${output}\n`)
    )
    await cleanup()
    process.exit(0)
  } catch (error) {
    // The spinner is mid-step when a step throws; without this the line it was
    // showing stays on screen as if it had not finished failing.
    if (spinner.isSpinning) spinner.fail(errorMessage(error))
    await cleanup()
    throw error
  }
}
