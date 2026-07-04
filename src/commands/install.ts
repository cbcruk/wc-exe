import ora from 'ora'
import chalk from 'chalk'
import {
  startServer,
  startServerWithFallback,
  type ServerInfo,
} from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import { listProjectFiles, readProjectFileBytes } from '../core/file-sync.js'
import {
  CACHE_PORT,
  CHROME_PROFILE_DIR,
  ensureCacheDirs,
} from '../core/cache.js'
import { withSpin } from '../utils/spinner.js'
import type { InstallOptions, ServerHandlers } from '../types.js'

export async function install(options: InstallOptions): Promise<void> {
  const { cache = false } = options

  console.log(chalk.cyan('\n  wc-exe install - Dependency Installation\n'))

  if (cache) ensureCacheDirs()

  const spinner = ora()
  let serverInfo: ServerInfo | undefined
  let browser: WCBrowser | null = null

  const handlers: ServerHandlers = {
    listFiles: () => listProjectFiles('.'),
    readFile: (relPath) => readProjectFileBytes('.', relPath),
  }

  const cleanup = async (): Promise<void> => {
    spinner.stop()
    await browser?.close()
    if (serverInfo?.server) {
      const server = serverInfo.server
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\n  Installation cancelled.\n'))
    await cleanup()
    process.exit(130)
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

    browser = new WCBrowser({
      verbose: true,
      userDataDir: cacheStable ? CHROME_PROFILE_DIR : undefined,
    })
    await withSpin({
      spinner,
      message: 'Launching headless browser...',
      fn: () => browser!.launch(serverInfo!.url),
      successMessage: 'WebContainer booted',
      failMessage: 'Failed to launch browser',
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
          const code = await browser!.runCommand('npm', ['install'])
          if (code !== 0)
            throw new Error(`npm install failed with exit code ${code}`)
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
