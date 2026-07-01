import ora from 'ora'
import chalk from 'chalk'
import { startServer, type ServerInfo } from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import { listProjectFiles, readProjectFileBytes } from '../core/file-sync.js'
import { withSpin } from '../utils/spinner.js'
import type { InstallOptions, ServerHandlers } from '../types.js'

export async function install(options: InstallOptions): Promise<void> {
  const { cache: _cache = false } = options

  console.log(chalk.cyan('\n  wc-exe install - Dependency Installation\n'))

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
      fn: () => startServer(handlers),
      successMessage: (info) => `Server started on ${info.url}`,
      failMessage: 'Failed to start server',
    })

    browser = new WCBrowser({ verbose: true })
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

    console.log(chalk.green('\n  Installation complete!\n'))
    await cleanup()
    process.exit(0)
  } catch (error) {
    await cleanup()
    throw error
  }
}
