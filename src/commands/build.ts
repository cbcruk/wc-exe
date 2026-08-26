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
import { withSpin } from '../utils/spinner.js'
import { commandFailure } from '../core/command-error.js'
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
    if (serverInfo?.server) {
      const server = serverInfo.server
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\n  Build cancelled.\n'))
    await cleanup()
    process.exit(130)
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

    await withSpin({
      spinner,
      message: 'Mounting files to WebContainer...',
      fn: () => browser!.mountFromServer(),
      successMessage: (count) => `Mounted ${count} files`,
      failMessage: 'Failed to mount files',
    })

    // The project's own package manager, not npm by assumption: the three
    // build different dependency trees from the same package.json, and using
    // the wrong one breaks projects that build fine locally.
    const { manager, reason, command, argsPrefix, note } =
      await browser.packageManager()
    if (verbose)
      console.log(
        chalk.gray(`  package manager: ${manager} (${reason}; ${note})`)
      )

    if (!noInstall) {
      if (cacheStable) {
        await withSpin({
          spinner,
          message: 'Installing dependencies (with OPFS cache)...',
          fn: () => browser!.installWithCache(),
          successMessage: (r) =>
            r.cached
              ? `Restored node_modules from cache (${r.key.slice(0, 12)})`
              : `Installed and cached node_modules (${((r.bytes ?? 0) / 1048576).toFixed(1)} MB)`,
          failMessage: (err) => `${manager} install failed: ${err.message}`,
        })
      } else {
        await withSpin({
          spinner,
          message: `Installing dependencies (${manager} install)...`,
          fn: async () => {
            const result = await browser!.runCommand(
              command,
              [...argsPrefix, 'install'],
              { timeout }
            )
            if (result.exitCode !== 0)
              throw commandFailure(`${manager} install`, result)
          },
          successMessage: 'Dependencies installed',
          failMessage: (err) => `${manager} install failed: ${err.message}`,
        })
      }
    }

    await withSpin({
      spinner,
      message: `Building project (${manager} run build)...`,
      fn: async () => {
        const result = await browser!.runCommand(
          command,
          [...argsPrefix, 'run', 'build'],
          { timeout }
        )
        if (result.exitCode !== 0)
          throw commandFailure(`${manager} run build`, result)
      },
      successMessage: 'Build completed',
      failMessage: (err) => `Build failed: ${err.message}`,
    })

    await prepareOutputDir(output)

    await withSpin({
      spinner,
      message: `Writing dist files to ${output}...`,
      fn: () => browser!.uploadDist(distDir),
      successMessage: (count) => `Wrote ${count} files to ${output}`,
      failMessage: `Failed to write to ${output}`,
    })

    console.log(chalk.green(`\n  Build successful!\n`))
    await cleanup()
    process.exit(0)
  } catch (error) {
    await cleanup()
    throw error
  }
}
