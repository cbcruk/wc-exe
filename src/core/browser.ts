import { type Browser, type Page } from 'puppeteer-core'
import { launchChrome } from './chrome.js'
import type {
  CacheResult,
  CommandResult,
  RunCommandOptions,
  ShellExecResult,
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
  /** Live output listeners, by shell id; see {@link openShell}. */
  private shellListeners = new Map<string, (chunk: string) => void>()
  /** Whether `__wcShellData__` has been bound on the page yet. */
  private shellDataBound = false
  /** A browser supplied by the caller, shared with other instances. */
  private sharedBrowser: Browser | undefined
  /** Whether {@link close} should close the browser or only this page. */
  private ownsBrowser = true

  /**
   * @param options.verbose Mirror browser console and failed requests to stdout.
   * @param options.userDataDir Persistent Chrome profile. Required for the OPFS
   *   cache to survive across runs; omit for a throwaway profile. Ignored when
   *   `browser` is supplied, since that browser already has a profile.
   * @param options.browser An already-running browser to open a page on,
   *   instead of launching one. Required when several instances must coexist:
   *   Chrome allows only one process per profile directory, so launching one
   *   browser apiece against a shared profile fails outright. {@link close}
   *   then closes only this page and leaves the browser to its owner.
   */
  constructor(options?: {
    verbose?: boolean
    userDataDir?: string
    browser?: Browser
  }) {
    this.verbose = options?.verbose ?? false
    this.userDataDir = options?.userDataDir
    this.sharedBrowser = options?.browser
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
    if (this.sharedBrowser) {
      this.browser = this.sharedBrowser
      this.ownsBrowser = false
    } else {
      // A persistent profile keeps OPFS (the node_modules cache) across runs.
      this.browser = await launchChrome({ userDataDir: this.userDataDir })
      this.ownsBrowser = true
    }

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
   * Opens an interactive shell inside the runtime.
   *
   * Output is pushed to `onData` as it arrives rather than polled, so a
   * terminal attached to this stays responsive.
   *
   * Prefer {@link runCommand} for one-off commands: a fresh process per command
   * has no shared state to leak, and none of a long-lived shell's fragility.
   * This is for interactive use, where the session is the point.
   *
   * @param id Caller-chosen id, used by the other `shell*` methods.
   * @throws If a shell with this id is already open.
   */
  async openShell(
    id: string,
    options?: { cols?: number; rows?: number; onData?: (chunk: string) => void }
  ): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    if (options?.onData && !this.shellDataBound) {
      // exposeFunction can only bind a name once per page, so the single bound
      // callback fans out to whichever shells are open.
      await this.page.exposeFunction(
        '__wcShellData__',
        (shellId: string, chunk: string) => {
          this.shellListeners.get(shellId)?.(chunk)
        }
      )
      this.shellDataBound = true
    }

    if (options?.onData) this.shellListeners.set(id, options.onData)

    await this.page.evaluate(
      async (idArg: string, optionsArg: { cols?: number; rows?: number }) => {
        await (
          window as unknown as {
            wcRunner: {
              openShell: (
                i: string,
                o?: { cols?: number; rows?: number }
              ) => Promise<void>
            }
          }
        ).wcRunner.openShell(idArg, optionsArg)
      },
      id,
      { cols: options?.cols, rows: options?.rows }
    )
  }

  /**
   * Runs one command in an open shell and waits for it to finish.
   *
   * @returns The command's output and exit status.
   */
  async shellExec(id: string, command: string): Promise<ShellExecResult> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(
      async (idArg: string, commandArg: string) => {
        return await (
          window as unknown as {
            wcRunner: {
              shellExec: (i: string, c: string) => Promise<ShellExecResult>
            }
          }
        ).wcRunner.shellExec(idArg, commandArg)
      },
      id,
      command
    )
  }

  /**
   * Sends Ctrl-C to an open shell.
   *
   * @throws If the shell does not acknowledge it — which means job control has
   *   died and the session should be discarded, not retried.
   */
  async shellInterrupt(id: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(async (idArg: string) => {
      await (
        window as unknown as {
          wcRunner: { shellInterrupt: (i: string) => Promise<void> }
        }
      ).wcRunner.shellInterrupt(idArg)
    }, id)
  }

  /** Tells an open shell its terminal was resized. */
  async shellResize(id: string, dimensions: TerminalSize): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(
      async (idArg: string, dimensionsArg: TerminalSize) => {
        ;(
          window as unknown as {
            wcRunner: { shellResize: (i: string, d: TerminalSize) => void }
          }
        ).wcRunner.shellResize(idArg, dimensionsArg)
      },
      id,
      dimensions
    )
  }

  /**
   * Why an open shell can no longer be trusted, or `null` while it is healthy.
   *
   * Worth checking between commands in a long-lived session: a broken shell
   * keeps running commands and printing output, so nothing else reveals it.
   */
  async shellBrokenReason(id: string): Promise<string | null> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (idArg: string) => {
      return (
        window as unknown as {
          wcRunner: { shellBrokenReason: (i: string) => string | null }
        }
      ).wcRunner.shellBrokenReason(idArg)
    }, id)
  }

  /**
   * Actively proves an open shell's job control still works: runs a command
   * that never ends, interrupts it, and requires the shell to accept another
   * command afterwards.
   *
   * This is the authoritative health check. Unlike {@link shellBrokenReason} it
   * reads no error strings from the shell, so a wording change cannot silently
   * disable it — but it costs a few seconds, so it suits session checkout
   * rather than every command.
   *
   * @returns `true` if job control works. `false` marks the shell broken.
   */
  async shellVerifyJobControl(id: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (idArg: string) => {
      return await (
        window as unknown as {
          wcRunner: { shellVerifyJobControl: (i: string) => Promise<boolean> }
        }
      ).wcRunner.shellVerifyJobControl(idArg)
    }, id)
  }

  /** Closes an open shell. Unknown ids are ignored. */
  async closeShell(id: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    this.shellListeners.delete(id)

    await this.page.evaluate(async (idArg: string) => {
      ;(
        window as unknown as { wcRunner: { closeShell: (i: string) => void } }
      ).wcRunner.closeShell(idArg)
    }, id)
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

  /**
   * Releases this instance's resources. Safe to call when not launched.
   *
   * Closes the browser only when this instance launched it. With a shared
   * browser it closes just the page, because the other sessions on that browser
   * are still using it.
   */
  async close(): Promise<void> {
    if (this.ownsBrowser) {
      await this.browser?.close()
    } else {
      await this.page?.close().catch(() => undefined)
    }
    this.browser = null
    this.page = null
  }
}
