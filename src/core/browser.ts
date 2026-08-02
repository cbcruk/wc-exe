import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type {
  CacheResult,
  CommandResult,
  RunCommandOptions,
  TerminalSize,
} from '../types.js'

/**
 * Drives the headless Chrome instance that hosts the runner page.
 *
 * Every method below is a thin bridge to the corresponding `window.wcRunner`
 * function evaluated inside the page — this class holds no runtime state of its
 * own, only the browser and page handles. Call {@link launch} before anything
 * else, and {@link close} when done.
 */
export class WCBrowser {
  private browser: Browser | null = null
  private page: Page | null = null
  private verbose: boolean = false
  private userDataDir: string | undefined
  /** Source of generated command handles; see {@link runCommand}. */
  private handleSequence = 0

  /**
   * @param options.verbose Mirror browser console and failed requests to stdout.
   * @param options.userDataDir Persistent Chrome profile. Required for the OPFS
   *   cache to survive across runs; omit for a throwaway profile.
   */
  constructor(options?: { verbose?: boolean; userDataDir?: string }) {
    this.verbose = options?.verbose ?? false
    this.userDataDir = options?.userDataDir
  }

  /**
   * Launches Chrome, opens the runner page and waits for the runtime to boot.
   *
   * @param serverUrl Origin the runner is served from, i.e. the local server's
   *   `url`.
   * @throws If Chrome cannot be located, or the runtime does not signal ready
   *   within 60s.
   */
  async launch(serverUrl: string): Promise<void> {
    const executablePath = await this.findChrome()

    this.browser = await puppeteer.launch({
      headless: true,
      executablePath,
      protocolTimeout: 600000,
      // A persistent profile keeps OPFS (the node_modules cache) across runs.
      userDataDir: this.userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    })

    this.page = await this.browser.newPage()

    if (this.verbose) {
      this.page.on('console', (msg) => {
        console.log('[Browser]', msg.text())
      })

      this.page.on('response', (response) => {
        if (!response.ok()) {
          console.log('[Browser 404]', response.url(), response.status())
        }
      })
    }

    this.page.on('pageerror', (err) => {
      console.error('[Browser Error]', err.message)
    })

    await this.page.goto(serverUrl)

    await this.page.waitForFunction(
      () =>
        (window as unknown as { __WC_READY__?: boolean }).__WC_READY__ === true,
      { timeout: 60000 }
    )
  }

  /**
   * Resolves a Chrome executable: `CHROME_PATH` if set, otherwise the first hit
   * among the well-known install locations for macOS, Linux and Windows.
   */
  private async findChrome(): Promise<string> {
    const { access } = await import('node:fs/promises')

    const envPath = process.env.CHROME_PATH
    if (envPath) {
      try {
        await access(envPath)
        return envPath
      } catch {
        throw new Error(`CHROME_PATH is set but not accessible: ${envPath}`)
      }
    }

    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]

    for (const chromePath of paths) {
      try {
        await access(chromePath)
        return chromePath
      } catch {
        continue
      }
    }

    throw new Error(
      'Chrome not found. Please install Chrome or set CHROME_PATH environment variable.'
    )
  }

  /**
   * Has the runner pull the project from the local server and mount it into the
   * runtime.
   *
   * @returns Number of files mounted.
   */
  async mountFromServer(): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async () => {
      return await (
        window as unknown as {
          wcRunner: { mountFromServer: () => Promise<number> }
        }
      ).wcRunner.mountFromServer()
    })
  }

  /**
   * Installs dependencies through the OPFS cache: restores a `node_modules`
   * snapshot when one matches the lockfile, otherwise installs and snapshots it
   * for next time.
   *
   * Only useful when the instance was constructed with a persistent
   * `userDataDir` and the server bound its fixed cache port; otherwise OPFS
   * starts empty and every run is a miss.
   *
   * @returns `cached` whether the snapshot was reused, `key` the lockfile hash
   *   it is stored under, and on a miss `bytes` the snapshot size plus the
   *   tarball-cache stats (`npmCacheRestored`, `npmCacheBytes`).
   * @throws If the install fails.
   */
  async installWithCache(): Promise<CacheResult> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async () => {
      return await (
        window as unknown as {
          wcRunner: { installWithCache: () => Promise<CacheResult> }
        }
      ).wcRunner.installWithCache()
    })
  }

  /**
   * Runs a command inside the runtime and waits for it to exit.
   *
   * @param cmd Executable name, e.g. `npm`.
   * @param args Arguments, e.g. `['run', 'build']`.
   * @param options Timeout, working directory, environment and terminal size.
   * @returns Exit code and captured output — a non-zero exit resolves, it does
   *   not throw.
   * @throws If `options.timeout` elapses. The command is killed first, so it
   *   does not keep running in the page.
   */
  async runCommand(
    cmd: string,
    args: string[],
    options?: RunCommandOptions
  ): Promise<CommandResult> {
    if (!this.page) throw new Error('Browser not launched')

    const { timeout, handle: explicitHandle, ...spawnOptions } = options ?? {}
    // A timeout needs something to cancel, so give the command a name even when
    // the caller did not ask for one.
    const handle =
      explicitHandle ?? (timeout ? `wc-${++this.handleSequence}` : undefined)

    const commandPromise = this.page.evaluate(
      async (
        cmdArg: string,
        argsArg: string[],
        optionsArg: Record<string, unknown>
      ) => {
        return await (
          window as unknown as {
            wcRunner: {
              runCommand: (
                c: string,
                a: string[],
                o?: Record<string, unknown>
              ) => Promise<CommandResult>
            }
          }
        ).wcRunner.runCommand(cmdArg, argsArg, optionsArg)
      },
      cmd,
      args,
      { ...spawnOptions, ...(handle ? { handle } : {}) }
    )

    if (!timeout) {
      return commandPromise
    }

    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Kill before rejecting, otherwise the command runs on invisibly and
        // keeps consuming the runtime for the rest of the session.
        void this.killCommand(handle!).finally(() => {
          reject(
            new Error(
              `Command timed out after ${timeout}ms: ${cmd} ${args.join(' ')}`
            )
          )
        })
      }, timeout)
    })

    try {
      return await Promise.race([commandPromise, timeoutPromise])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Terminates a command started with a `handle`.
   *
   * @returns `true` if a running command matched. `false` means it had already
   *   exited — a normal race, not an error.
   */
  async killCommand(handle: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (handleArg: string) => {
      return (
        window as unknown as {
          wcRunner: { killCommand: (h: string) => boolean }
        }
      ).wcRunner.killCommand(handleArg)
    }, handle)
  }

  /**
   * Tells a running command its terminal was resized.
   *
   * @returns `true` if a running command matched, `false` otherwise.
   */
  async resizeCommand(
    handle: string,
    dimensions: TerminalSize
  ): Promise<boolean> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(
      async (handleArg: string, dimensionsArg: TerminalSize) => {
        return (
          window as unknown as {
            wcRunner: {
              resizeCommand: (h: string, d: TerminalSize) => boolean
            }
          }
        ).wcRunner.resizeCommand(handleArg, dimensionsArg)
      },
      handle,
      dimensions
    )
  }

  /**
   * Walks the build output inside the runtime and POSTs each file back to the
   * local server, which writes it to the host output directory.
   *
   * @param distPath Absolute path inside the runtime. Defaults to `/dist`.
   * @returns Number of files uploaded.
   */
  async uploadDist(distPath: string = '/dist'): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (pathArg: string) => {
      return await (
        window as unknown as {
          wcRunner: { uploadDist: (p: string) => Promise<number> }
        }
      ).wcRunner.uploadDist(pathArg)
    }, distPath)
  }

  /**
   * Starts a long-running command inside the runtime without waiting for it to
   * exit — for dev servers and watchers. Pair with {@link waitForServerReady}.
   *
   * Resolves as soon as the spawn is issued; a failure inside the runtime
   * surfaces in the page console, not here.
   */
  async spawnCommand(cmd: string, args: string[]): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(
      (cmdArg: string, argsArg: string[]) => {
        ;(
          window as unknown as {
            wcRunner: {
              spawnCommand: (c: string, a: string[]) => void
            }
          }
        ).wcRunner.spawnCommand(cmdArg, argsArg)
      },
      cmd,
      args
    )
  }

  /**
   * Waits for a server started inside the runtime (via {@link spawnCommand}) to
   * come up.
   *
   * @returns The runtime-internal port and the proxied URL to forward traffic
   *   to. Never rejects on its own — it waits indefinitely if no server starts.
   */
  async waitForServerReady(): Promise<{ port: number; url: string }> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async () => {
      return await (
        window as unknown as {
          wcRunner: {
            getServerUrl: () => Promise<{ port: number; url: string }>
          }
        }
      ).wcRunner.getServerUrl()
    })
  }

  /**
   * Deletes paths inside the runtime that no longer exist on the host.
   *
   * Mounting only adds and overwrites, so without this a deleted file stays
   * resolvable in a long-lived runtime and the build keeps succeeding against
   * source that is gone.
   *
   * @param paths Project-root-relative paths. Missing paths are ignored.
   * @returns How many paths were requested.
   * @throws If the browser has not been launched.
   */
  async removePaths(paths: string[]): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (pathsArg: string[]) => {
      return await (
        window as unknown as {
          wcRunner: { removePaths: (p: string[]) => Promise<number> }
        }
      ).wcRunner.removePaths(pathsArg)
    }, paths)
  }

  /**
   * Writes a single file inside the runtime — how host edits are pushed in for
   * HMR.
   *
   * @param path Absolute path inside the runtime, e.g. `/src/main.ts`.
   * @param content UTF-8 text. Binary files are not supported here.
   */
  async writeFile(path: string, content: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(
      async (pathArg: string, contentArg: string) => {
        await (
          window as unknown as {
            wcRunner: {
              writeFile: (p: string, c: string) => Promise<void>
            }
          }
        ).wcRunner.writeFile(pathArg, contentArg)
      },
      path,
      content
    )
  }

  /** Closes the browser and drops the handles. Safe to call when not launched. */
  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = null
    this.page = null
  }
}
