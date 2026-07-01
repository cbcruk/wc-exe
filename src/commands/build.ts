import ora from 'ora'
import chalk from 'chalk'
import { startServer, type ServerInfo } from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  prepareOutputDir,
  writeDistFile,
} from '../core/file-sync.js'
import { withSpin } from '../utils/spinner.js'
import type { BuildOptions, ServerHandlers } from '../types.js'

export async function build(options: BuildOptions): Promise<void> {
  const {
    source = '.',
    output = './dist',
    distDir = '/dist',
    noInstall = false,
    verbose = false,
    timeout,
  } = options

  console.log(chalk.cyan('\n  wc-exe - WebContainer Executor\n'))

  const spinner = ora()

  let serverInfo: ServerInfo | undefined
  let browser: WCBrowser | null = null

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
      fn: () => startServer(handlers),
      successMessage: (info) => `Server started on ${info.url}`,
      failMessage: 'Failed to start server',
    })

    browser = new WCBrowser({ verbose })
    await withSpin({
      spinner,
      message: 'Launching headless browser...',
      fn: () => browser!.launch(serverInfo!.url),
      successMessage: 'WebContainer booted',
      failMessage: 'Failed to launch browser',
    })

    await withSpin({
      spinner,
      message: 'Mounting files to WebContainer...',
      fn: () => browser!.mountFromServer(),
      successMessage: (count) => `Mounted ${count} files`,
      failMessage: 'Failed to mount files',
    })

    if (!noInstall) {
      await withSpin({
        spinner,
        message: 'Installing dependencies (npm install)...',
        fn: async () => {
          const code = await browser!.runCommand('npm', ['install'], timeout)
          if (code !== 0)
            throw new Error(`npm install failed with exit code ${code}`)
        },
        successMessage: 'Dependencies installed',
        failMessage: (err) => `npm install failed: ${err.message}`,
      })
    }

    await withSpin({
      spinner,
      message: 'Building project (npm run build)...',
      fn: async () => {
        const code = await browser!.runCommand('npm', ['run', 'build'], timeout)
        if (code !== 0)
          throw new Error(`npm run build failed with exit code ${code}`)
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
