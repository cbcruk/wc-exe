import type { RunnerLink } from './rpc.js'
import { openInBrowser } from './open.js'
import type {
  CacheResult,
  ClearCacheResult,
  CommandResult,
  PackageManagerChoice,
  RunCommandOptions,
  ShellExecResult,
  TerminalSize,
} from './types.js'

/**
 * The host's half of the runner API.
 *
 * Every method below is a call on the page's `window.wcRunner`, sent over the
 * control channel; this class holds no runtime state of its own.
 *
 * It used to launch and own a headless Chrome, which is why it was called
 * `WCBrowser`. It does not any more: the page drives itself over
 * {@link RunnerLink}, so the host only needs a tab to exist at a URL, not a
 * browser it controls. What is left is a typed client for a runner that is
 * somewhere else — which is all the name now claims.
 *
 * Call {@link launch} before anything else, and {@link close} when done.
 */
export class RunnerClient {
  private verbose: boolean = false
  private readonly link: RunnerLink

  /** Calls a method on the page's `wcRunner`. */
  private callRunner<T>(method: string, args: unknown[] = []): Promise<T> {
    return this.link.call<T>(method, args)
  }
  /** Source of generated command handles; see {@link runCommand}. */
  private handleSequence = 0
  /** Live output listeners, by shell id; see {@link openShell}. */
  private shellListeners = new Map<string, (chunk: string) => void>()
  /** Whether `__wcShellData__` has been bound on the page yet. */
  private shellDataBound = false

  /**
   * @param options.verbose Mirror runner diagnostics to stdout.
   * @param options.link Control channel the page attaches to; every method
   *   below goes over it.
   */
  constructor(options: { verbose?: boolean; link: RunnerLink }) {
    this.verbose = options?.verbose ?? false
    this.link = options.link
  }

  /**
   * Opens the runner page and waits for the runtime to boot.
   *
   * @param serverUrl Origin the runner is served from, i.e. the local server's
   *   `url`.
   * @param options.open Hand the URL to the desktop browser. Set `false` when
   *   the caller has already opened it, or wants to open it by hand — the wait
   *   below is identical either way, since the host cannot tell which tab it is
   *   talking to.
   * @throws If the runtime does not signal ready within 60s.
   */
  async launch(
    serverUrl: string,
    options: { open?: boolean } = {}
  ): Promise<void> {
    // Registered before the page can exist: a page that fails on load would
    // otherwise report nothing, and the only symptom would be the ready wait
    // expiring a minute later with no cause attached.
    this.link.onEvent('pageError', (payload) => {
      const { message } = (payload ?? {}) as { message?: string }
      console.error('[Runner Error]', message ?? 'unknown page error')
    })

    if (options.open !== false) {
      // A failure here is not fatal. The caller shows the URL, and a user
      // pasting it into a browser produces exactly the same tab.
      await openInBrowser(serverUrl)
    }

    // The page reports this over the control channel rather than the host
    // polling a global through CDP — which is the point: a page the host did
    // not launch has no global for the host to read.
    await this.link.waitForReady(60_000)
    if (this.verbose) console.log('[Runner] control channel attached')
  }

  /**
   * Has the runner pull the project from the local server and mount it into the
   * runtime.
   *
   * @returns Number of files mounted.
   */
  async mountFromServer(): Promise<number> {
    return this.callRunner('mountFromServer')
  }

  /**
   * Installs dependencies through the OPFS cache: restores a `node_modules`
   * snapshot when one matches the lockfile, otherwise installs and snapshots it
   * for next time.
   *
   * Only useful when the server bound its fixed cache port. OPFS is scoped per
   * origin, so a random port orphans the previous run's snapshot and every run
   * is a miss. The browser profile is no longer a variable here — the page runs
   * in the user's own browser, so its storage persists on its own.
   *
   * @returns `cached` whether the snapshot was reused, `key` the lockfile hash
   *   it is stored under, and on a miss `bytes` the snapshot size plus the
   *   tarball-cache stats (`npmCacheRestored`, `npmCacheBytes`).
   * @throws If the install fails.
   */
  async installWithCache(): Promise<CacheResult> {
    return this.callRunner('installWithCache')
  }

  /**
   * Reports the runtime's working directory and default `PATH`.
   *
   * `PATH` is the only way to learn what the backend can run: its filesystem
   * resolves even absolute paths under the working directory, so the
   * directories on `PATH` are invisible to it.
   */
  async describeRuntime(): Promise<{ workdir: string; path: string }> {
    return this.callRunner('describeRuntime')
  }

  /**
   * Deletes every wc-exe cache blob in the page's OPFS.
   *
   * The host used to do this by deleting the Chrome profile directory it owned;
   * with the page in the user's own browser there is no such directory, and the
   * page's origin is the only thing that can reach that storage. Benchmarks
   * that need a genuinely cold cache go through here.
   *
   * @returns Which blobs went and how big they were, so a caller can assert it
   *   really started cold instead of assuming it.
   */
  async clearCache(): Promise<ClearCacheResult> {
    return this.callRunner('clearCache')
  }

  /**
   * Asks the runtime which package manager this project uses.
   *
   * Decided from the mounted files rather than the host copy, so the answer
   * comes from exactly the tree that will be installed and built.
   */
  async packageManager(): Promise<PackageManagerChoice> {
    return this.callRunner('resolvePackageManager')
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
    const { timeout, handle: explicitHandle, ...spawnOptions } = options ?? {}
    // A timeout needs something to cancel, so give the command a name even when
    // the caller did not ask for one.
    const handle =
      explicitHandle ?? (timeout ? `wc-${++this.handleSequence}` : undefined)

    const commandPromise = this.callRunner<CommandResult>('runCommand', [
      cmd,
      args,
      { ...spawnOptions, ...(handle ? { handle } : {}) },
    ])

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
    if (options?.onData && !this.shellDataBound) {
      // One subscription fans out to whichever shells are open, the same way
      // the exposed function used to — the page emits one event stream and the
      // shell id picks the listener.
      this.link?.onEvent('shellData', (payload) => {
        const { id: shellId, chunk } = payload as { id: string; chunk: string }
        this.shellListeners.get(shellId)?.(chunk)
      })
      this.shellDataBound = true
    }

    if (options?.onData) this.shellListeners.set(id, options.onData)

    await this.callRunner('openShell', [
      id,
      { cols: options?.cols, rows: options?.rows },
    ])
  }

  /**
   * Runs one command in an open shell and waits for it to finish.
   *
   * @returns The command's output and exit status.
   */
  async shellExec(id: string, command: string): Promise<ShellExecResult> {
    return this.callRunner('shellExec', [id, command])
  }

  /**
   * Sends Ctrl-C to an open shell.
   *
   * @throws If the shell does not acknowledge it — which means job control has
   *   died and the session should be discarded, not retried.
   */
  async shellInterrupt(id: string): Promise<void> {
    return this.callRunner('shellInterrupt', [id])
  }

  /** Tells an open shell its terminal was resized. */
  async shellResize(id: string, dimensions: TerminalSize): Promise<void> {
    return this.callRunner('shellResize', [id, dimensions])
  }

  /**
   * Why an open shell can no longer be trusted, or `null` while it is healthy.
   *
   * Worth checking between commands in a long-lived session: a broken shell
   * keeps running commands and printing output, so nothing else reveals it.
   */
  async shellBrokenReason(id: string): Promise<string | null> {
    return this.callRunner('shellBrokenReason', [id])
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
    return this.callRunner('shellVerifyJobControl', [id])
  }

  /** Closes an open shell. Unknown ids are ignored. */
  async closeShell(id: string): Promise<void> {
    return this.callRunner('closeShell', [id])
  }

  /**
   * Terminates a command started with a `handle`.
   *
   * @returns `true` if a running command matched. `false` means it had already
   *   exited — a normal race, not an error.
   */
  async killCommand(handle: string): Promise<boolean> {
    return this.callRunner('killCommand', [handle])
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
    return this.callRunner('resizeCommand', [handle, dimensions])
  }

  /**
   * Walks the build output inside the runtime and POSTs each file back to the
   * local server, which writes it to the host output directory.
   *
   * @param distPath Absolute path inside the runtime. Defaults to `/dist`.
   * @returns Number of files uploaded.
   */
  async uploadDist(distPath: string = '/dist'): Promise<number> {
    return this.callRunner('uploadDist', [distPath])
  }

  /**
   * Starts a long-running command inside the runtime without waiting for it to
   * exit — for dev servers and watchers. Pair with {@link waitForServerReady}.
   *
   * Resolves as soon as the spawn is issued; a failure inside the runtime
   * surfaces in the page console, not here.
   */
  async spawnCommand(cmd: string, args: string[]): Promise<void> {
    return this.callRunner('spawnCommand', [cmd, args])
  }

  /**
   * Waits for a server started inside the runtime (via {@link spawnCommand}) to
   * come up.
   *
   * @returns The runtime-internal port and the proxied URL to forward traffic
   *   to. Never rejects on its own — it waits indefinitely if no server starts.
   */
  async waitForServerReady(): Promise<{ port: number; url: string }> {
    return this.callRunner('getServerUrl')
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
   * @throws If the runner page is not attached.
   */
  async removePaths(paths: string[]): Promise<number> {
    return this.callRunner('removePaths', [paths])
  }

  /**
   * Writes a single file inside the runtime — how host edits are pushed in for
   * HMR.
   *
   * @param path Absolute path inside the runtime, e.g. `/src/main.ts`.
   * @param content UTF-8 text. Binary files are not supported here.
   */
  async writeFile(path: string, content: string): Promise<void> {
    return this.callRunner('writeFile', [path, content])
  }

  /**
   * Releases this instance's resources. Safe to call when not launched.
   *
   * **The tab is left open.** The host does not own it and has no way to close
   * it, which is the deliberate trade for not shipping a browser: the user
   * opened the page and the user closes it. Failing every in-flight call is the
   * part that does matter, so a host exiting mid-build does not leave promises
   * nothing can settle.
   */
  async close(): Promise<void> {
    this.link.close('Runner client closed')
  }
}
