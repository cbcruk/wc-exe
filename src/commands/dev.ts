import ora from 'ora'
import chalk from 'chalk'
import chokidar from 'chokidar'
import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'
import httpProxy from 'http-proxy'
import { startServer, type ServerInfo } from '../core/server.js'
import { RunnerClient } from '../core/runner-client.js'
import { listProjectFiles, readProjectFileBytes } from '../core/file-sync.js'
import { withSpin } from '../utils/spinner.js'
import { onInterrupt } from '../utils/interrupt.js'
import { commandFailure } from '../core/errors.js'
import type { ServerHandlers } from '../core/types.js'
import type { DevOptions } from '../types.js'

/**
 * Runs the project's dev server inside the browser runtime and proxies it to a
 * local port.
 *
 * Mounts the current directory, installs dependencies, spawns `npm run dev`,
 * then proxies HTTP and WebSocket traffic to the runtime. A file watcher pushes
 * host edits back in so HMR works against real files on disk.
 *
 * @param options See {@link DevOptions}.
 * @throws If any startup step fails. The watcher, proxy and link are torn down
 *   first; the runner tab is the user's to close.
 * @remarks Never resolves — it runs until interrupted (SIGINT).
 */
export async function dev(options: DevOptions): Promise<void> {
  const { port = 5173, open = true } = options

  console.log(chalk.cyan('\n  wc-exe dev - Development Server\n'))

  const spinner = ora()

  let serverInfo: ServerInfo | undefined
  let proxyServer: http.Server | undefined
  let browser: RunnerClient | null = null
  let watcher: chokidar.FSWatcher | null = null

  const cleanup = async (): Promise<void> => {
    spinner.stop()

    await watcher?.close()
    await browser?.close()

    if (proxyServer) {
      const server = proxyServer
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    await serverInfo?.shutdown()
  }

  onInterrupt({
    message: chalk.yellow('\n\n  Shutting down...\n'),
    cleanup,
    exitCode: 0,
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

    browser = new RunnerClient({ verbose: false, link: serverInfo.link })
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

    await withSpin({
      spinner,
      message: 'Installing dependencies...',
      fn: async () => {
        const { manager } = await browser!.packageManager()
        const result = await browser!.runCommand(manager, ['install'])
        if (result.exitCode !== 0)
          throw commandFailure(`${manager} install`, result)
      },
      successMessage: 'Dependencies installed',
      failMessage: (err) => `npm install failed: ${err.message}`,
    })

    const wcUrl = await withSpin({
      spinner,
      message: 'Starting dev server...',
      fn: async () => {
        // `waitForServerReady` waits for an event, and a dev server that never
        // started never emits one — it does not reject, it waits forever. The
        // spawn call is the only thing that can report that failure, and its
        // promise used to be dropped on the floor, so `npm run dev` failing to
        // start showed as a spinner that spun until the user gave up.
        //
        // On success `spawnCommand` resolves immediately (the runner returns as
        // soon as the process is spawned), so it must not win the race — hence
        // the promise that never settles behind it.
        const spawnFailed = browser!
          .spawnCommand('npm', ['run', 'dev'])
          .then(() => new Promise<never>(() => {}))

        const { url } = await Promise.race([
          browser!.waitForServerReady(),
          spawnFailed,
        ])
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

        // chokidar does not await its listeners, so every handler below has
        // to be complete on its own: whatever it does not catch, nobody does.
        // They are named functions registered with `void` rather than `async`
        // arrows passed straight to `on`, so that contract is visible at the
        // call site instead of being something a reader has to know about
        // chokidar.
        const syncToRuntime = async (
          filePath: string,
          label: string
        ): Promise<void> => {
          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const wcPath =
              '/' + path.relative('.', filePath).replace(/\\/g, '/')
            await browser!.writeFile(wcPath, content)
            console.log(chalk.gray(`  [${label}] ${filePath}`))
          } catch {
            console.error(chalk.red(`  [Error] Failed to sync: ${filePath}`))
          }
        }

        // mount/writeFile only add and overwrite, so a deletion has to be
        // pushed explicitly — otherwise the dev server keeps resolving a file
        // the developer already removed.
        const removeFromRuntime = async (
          filePath: string,
          label: string
        ): Promise<void> => {
          try {
            const wcPath = path.relative('.', filePath).replace(/\\/g, '/')
            await browser!.removePaths([wcPath])
            console.log(chalk.gray(`  [${label}] ${filePath}`))
          } catch {
            console.error(chalk.red(`  [Error] Failed to remove: ${filePath}`))
          }
        }

        watcher.on('change', (filePath) => void syncToRuntime(filePath, 'HMR'))
        watcher.on('add', (filePath) => void syncToRuntime(filePath, 'Add'))
        watcher.on(
          'unlink',
          (filePath) => void removeFromRuntime(filePath, 'Del')
        )
        watcher.on(
          'unlinkDir',
          (dirPath) => void removeFromRuntime(dirPath, 'DelDir')
        )
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
