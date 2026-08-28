import ora from 'ora'
import chalk from 'chalk'
import {
  startServer,
  startServerWithFallback,
  type ServerInfo,
} from '../core/server.js'
import { RunnerClient } from '../core/runner-client.js'
import { listProjectFiles, readProjectFileBytes } from '../core/file-sync.js'
import { CACHE_PORT, ensureCacheDirs } from '../core/cache.js'
import { withSpin } from '../utils/spinner.js'
import { onInterrupt } from '../utils/interrupt.js'
import { commandFailure } from '../core/errors.js'
import type { ServerHandlers } from '../core/types.js'
import type { InstallOptions } from '../types.js'

/**
 * Installs the current project's dependencies inside the browser runtime,
 * without building.
 *
 * Mainly useful with `cache: true` to warm the OPFS `node_modules` snapshot
 * ahead of a build — nothing is written back to the host, the install lives in
 * the runtime.
 *
 * @param options See {@link InstallOptions}.
 * @throws If any step fails. The server and the link are always torn down
 *   first; the tab is the user's to close.
 * @remarks Calls `process.exit(0)` on success, so it never resolves — this is
 *   the CLI entry point, not a reusable library call.
 */
export async function install(options: InstallOptions): Promise<void> {
  const { cache = false, open = true } = options

  console.log(chalk.cyan('\n  wc-exe install - Dependency Installation\n'))

  if (cache) ensureCacheDirs()

  const spinner = ora()
  let serverInfo: ServerInfo | undefined
  let browser: RunnerClient | null = null

  const handlers: ServerHandlers = {
    listFiles: () => listProjectFiles('.'),
    readFile: (relPath) => readProjectFileBytes('.', relPath),
  }

  const cleanup = async (): Promise<void> => {
    spinner.stop()
    await browser?.close()
    await serverInfo?.shutdown()
  }

  onInterrupt({
    message: chalk.yellow('\n\n  Installation cancelled.\n'),
    cleanup,
    exitCode: 130,
  })

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

    browser = new RunnerClient({ verbose: true, link: serverInfo.link })
    await withSpin({
      spinner,
      message: `Waiting for the runner page at ${serverInfo.url} ...`,
      fn: () => browser!.launch(serverInfo!.url, { open }),
      successMessage: 'WebContainer booted',
      failMessage: 'The runner page never reported ready',
    })

    await withSpin({
      spinner,
      message: 'Mounting files...',
      fn: () => browser!.mountFromServer(),
      successMessage: (count) => `Mounted ${count} files`,
      failMessage: 'Failed to mount files',
    })

    if (cacheStable) {
      await withSpin({
        spinner,
        message: 'Installing dependencies (with OPFS cache)...',
        fn: () => browser!.installWithCache(),
        successMessage: (r) =>
          r.cached
            ? `Restored node_modules from cache (${r.key.slice(0, 12)})`
            : `Installed and cached node_modules (${((r.bytes ?? 0) / 1048576).toFixed(1)} MB)`,
        failMessage: (err) => `npm install failed: ${err.message}`,
      })
    } else {
      await withSpin({
        spinner,
        message: 'Installing dependencies (npm install)...',
        fn: async () => {
          const result = await browser!.runCommand('npm', ['install'])
          if (result.exitCode !== 0) throw commandFailure('npm install', result)
        },
        successMessage: 'Dependencies installed successfully',
        failMessage: (err) => `npm install failed: ${err.message}`,
      })
    }

    console.log(chalk.green('\n  Installation complete!\n'))
    await cleanup()
    process.exit(0)
  } catch (error) {
    await cleanup()
    throw error
  }
}
