import ora from 'ora'
import chalk from 'chalk'
import { startServer, type ServerInfo } from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import { readProjectFiles, writeDistFiles } from '../core/file-sync.js'
import { withSpin } from '../utils/spinner.js'
import type { BuildOptions } from '../types.js'

export async function build(options: BuildOptions): Promise<void> {
  const {
    source = '.',
    output = './dist',
    distDir = '/dist',
    noInstall = false,
    verbose = false,
    timeout,
  } = options

  console.log(chalk.cyan('\n  wc-build - WebContainer Build Tool\n'))

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

  try {
    serverInfo = await withSpin({
      spinner,
      message: 'Starting local server...',
      fn: () => startServer(),
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

    const files = await withSpin({
      spinner,
      message: 'Reading project files...',
      fn: () => readProjectFiles(source),
      successMessage: (f) => `Read ${countFiles(f)} files from source`,
      failMessage: 'Failed to read project files',
    })

    await withSpin({
      spinner,
      message: 'Mounting files to WebContainer...',
      fn: () => browser!.mountFiles(files),
      successMessage: 'Files mounted',
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

    const distFiles = await withSpin({
      spinner,
      message: 'Extracting dist files...',
      fn: () => browser!.extractDist(distDir),
      successMessage: (files) => `Extracted ${Object.keys(files).length} files`,
      failMessage: 'Failed to extract dist files',
    })

    await withSpin({
      spinner,
      message: `Writing to ${output}...`,
      fn: () => writeDistFiles(output, distFiles, distDir),
      successMessage: `Output written to ${output}`,
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

function countFiles(tree: Record<string, unknown>, count = 0): number {
  for (const value of Object.values(tree)) {
    if (typeof value === 'object' && value !== null) {
      if ('file' in value) {
        count++
      } else if ('directory' in value) {
        count = countFiles(
          (value as { directory: Record<string, unknown> }).directory,
          count
        )
      }
    }
  }

  return count
}
