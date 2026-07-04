import ora from 'ora'
import chalk from 'chalk'
import {
  startServer,
  startServerWithFallback,
  type ServerInfo,
} from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  prepareOutputDir,
  writeDistFile,
} from '../core/file-sync.js'
import {
  CACHE_PORT,
  CHROME_PROFILE_DIR,
  ensureCacheDirs,
} from '../core/cache.js'
import { withSpin } from '../utils/spinner.js'
import type { BuildOptions, ServerHandlers } from '../types.js'

export async function build(options: BuildOptions): Promise<void> {
  const {
    source = '.',
    output = './dist',
    distDir = '/dist',
    noInstall = false,
    cache = false,
    verbose = false,
    timeout,
  } = options

  console.log(chalk.cyan('\n  wc-exe - WebContainer Executor\n'))

  if (cache) ensureCacheDirs()

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
      verbose,
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
      message: 'Mounting files to WebContainer...',
      fn: () => browser!.mountFromServer(),
      successMessage: (count) => `Mounted ${count} files`,
      failMessage: 'Failed to mount files',
    })

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
          failMessage: (err) => `npm install failed: ${err.message}`,
        })
      } else {
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
