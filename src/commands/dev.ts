import ora from 'ora'
import chalk from 'chalk'
import chokidar from 'chokidar'
import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'
import httpProxy from 'http-proxy'
import { startServer, type ServerInfo } from '../core/server.js'
import { WCBrowser } from '../core/browser.js'
import { listProjectFiles, readProjectFileBytes } from '../core/file-sync.js'
import { withSpin } from '../utils/spinner.js'
import type { DevOptions, ServerHandlers } from '../types.js'

export async function dev(options: DevOptions): Promise<void> {
  const { port = 5173 } = options

  console.log(chalk.cyan('\n  wc-exe dev - Development Server\n'))

  const spinner = ora()

  let serverInfo: ServerInfo | undefined
  let proxyServer: http.Server | undefined
  let browser: WCBrowser | null = null
  let watcher: chokidar.FSWatcher | null = null

  const cleanup = async (): Promise<void> => {
    spinner.stop()

    await watcher?.close()
    await browser?.close()

    if (proxyServer) {
      const server = proxyServer
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    if (serverInfo?.server) {
      const server = serverInfo.server
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\n  Shutting down...\n'))
    await cleanup()
    process.exit(0)
  })

  const handlers: ServerHandlers = {
    listFiles: () => listProjectFiles('.'),
    readFile: (relPath) => readProjectFileBytes('.', relPath),
  }

  try {
    serverInfo = await withSpin({
      spinner,
      message: 'Starting WebContainer server...',
      fn: () => startServer(handlers),
      successMessage: (info) => `WebContainer server started on ${info.url}`,
      failMessage: 'Failed to start server',
    })

    browser = new WCBrowser({ verbose: false })
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
      message: 'Installing dependencies...',
      fn: async () => {
        const code = await browser!.runCommand('npm', ['install'])
        if (code !== 0) throw new Error('npm install failed')
      },
      successMessage: 'Dependencies installed',
      failMessage: (err) => `npm install failed: ${err.message}`,
    })

    const wcUrl = await withSpin({
      spinner,
      message: 'Starting dev server...',
      fn: async () => {
        browser!.spawnCommand('npm', ['run', 'dev'])
        const { url } = await browser!.waitForServerReady()
        return url
      },
      successMessage: (url) => `Dev server ready at ${url}`,
      failMessage: 'Failed to start dev server',
    })

    const proxy = httpProxy.createProxyServer({
      target: wcUrl,
      changeOrigin: true,
      ws: true,
    })

    proxyServer = http.createServer((req, res) => {
      proxy.web(req, res)
    })

    proxyServer.on('upgrade', (req, socket, head) => {
      proxy.ws(req, socket, head)
    })

    proxyServer.listen(port, () => {
      console.log(chalk.green(`\n  Dev server running at:`))
      console.log(chalk.cyan(`  http://localhost:${port}\n`))
      console.log(chalk.gray('  Press Ctrl+C to stop\n'))
    })

    await withSpin({
      spinner,
      message: 'Setting up file watcher...',
      fn: async () => {
        watcher = chokidar.watch('.', {
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/.next/**',
            '**/.nuxt/**',
          ],
          ignoreInitial: true,
        })

        watcher.on('change', async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const wcPath =
              '/' + path.relative('.', filePath).replace(/\\/g, '/')
            await browser!.writeFile(wcPath, content)
            console.log(chalk.gray(`  [HMR] ${filePath}`))
          } catch {
            console.error(chalk.red(`  [Error] Failed to sync: ${filePath}`))
          }
        })

        watcher.on('add', async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const wcPath =
              '/' + path.relative('.', filePath).replace(/\\/g, '/')
            await browser!.writeFile(wcPath, content)
            console.log(chalk.gray(`  [Add] ${filePath}`))
          } catch {
            console.error(chalk.red(`  [Error] Failed to add: ${filePath}`))
          }
        })
      },
      successMessage: 'File watcher ready',
      failMessage: 'Failed to setup file watcher',
    })

    await new Promise(() => {})
  } catch (error) {
    await cleanup()
    throw error
  }
}
