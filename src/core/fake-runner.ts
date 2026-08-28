/**
 * A runner that answers the control channel from Node, backed by a filesystem
 * that only exists in memory.
 *
 * This is a **backend, not a test helper**, and the distinction is the point.
 * The runner page needs a browser that can boot a WebContainer — cross-origin
 * isolation, `SharedArrayBuffer`, a real tab someone opened. That is not
 * available in CI and not available in this sandbox, so every test that wanted
 * to exercise more than one module at a time either did without, or hand-rolled
 * a stand-in that answered one call and stopped. `rpc.integration.test.ts`
 * keeps its own on purpose — those tests are about the transport and need a
 * stream they can cut on cue — but everything above the transport needs a page
 * that behaves like one.
 *
 * So the expensive dependency is put behind the interface it already had — the
 * control channel — and this is the other implementation. Everything above it
 * is the real thing: a real socket, `RunnerLink`, `RunnerClient`,
 * `runProjectBuild`, `Session`, the daemon's routes. The only fake is what
 * happens *inside* the runtime.
 *
 * **What this proves, and what it does not.** It proves the plumbing: that a
 * build's calls arrive in the right order, that files reach the runtime and
 * artifacts come back, that a deleted file is deleted, that a failure crosses
 * two transports with its tag intact. It proves nothing about whether a real
 * project builds — no command actually runs, there is no OPFS, no
 * `node_modules`, no package manager. A test that needs those needs a browser,
 * and `test/integration/` is where those live.
 *
 * @module
 */

import type {
  CacheResult,
  ClearCacheResult,
  CommandResult,
  PackageManagerChoice,
  RunCommandOptions,
} from './types.js'

/**
 * The runtime's filesystem.
 *
 * Flat, keyed by absolute path, because that is all the calls above it need: a
 * tree would model directories the fake never has to answer questions about.
 * Exposed rather than hidden — the reason this exists is so a test can ask what
 * is actually in the runtime, which is the question no browser-backed test can
 * answer without a round trip.
 */
export class FakeRuntimeFs {
  private readonly entries = new Map<string, Uint8Array>()

  /** Absolute paths currently present, sorted. */
  paths(under?: string): string[] {
    const prefix = under ? normalize(under) : undefined
    return [...this.entries.keys()]
      .filter(
        (p) =>
          prefix === undefined || p === prefix || p.startsWith(`${prefix}/`)
      )
      .sort()
  }

  /** Whether a file exists at this exact path. */
  has(path: string): boolean {
    return this.entries.has(normalize(path))
  }

  /** File contents as UTF-8, or `undefined` when there is no such file. */
  read(path: string): string | undefined {
    const data = this.entries.get(normalize(path))
    return data === undefined ? undefined : new TextDecoder().decode(data)
  }

  /** Raw bytes, or `undefined`. */
  readBytes(path: string): Uint8Array | undefined {
    return this.entries.get(normalize(path))
  }

  /** Writes a file, creating nothing else — there are no directories here. */
  write(path: string, contents: string | Uint8Array): void {
    const data =
      typeof contents === 'string'
        ? new TextEncoder().encode(contents)
        : contents
    this.entries.set(normalize(path), data)
  }

  /**
   * Removes a path and everything under it.
   *
   * Recursive and forgiving, like the `fs.rm(p, { recursive: true, force: true })`
   * the real runner uses — a missing path is not an error, which is what lets
   * `clearDist` run against a runtime that never built anything.
   *
   * @returns How many files went.
   */
  remove(path: string): number {
    const target = normalize(path)
    let removed = 0
    for (const existing of [...this.entries.keys()]) {
      if (existing === target || existing.startsWith(`${target}/`)) {
        this.entries.delete(existing)
        removed++
      }
    }
    return removed
  }

  /** Whether anything exists at or under this path. */
  exists(path: string): boolean {
    const target = normalize(path)
    for (const existing of this.entries.keys()) {
      if (existing === target || existing.startsWith(`${target}/`)) return true
    }
    return false
  }
}

/** Absolute, no trailing slash, no doubled separators. */
function normalize(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  return withLeading.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
}

/** One `runCommand` invocation, as the fake saw it. */
export interface FakeCommand {
  cmd: string
  args: string[]
  options: RunCommandOptions
}

/**
 * What a fake command did.
 *
 * A `Partial` so a test can say `{ exitCode: 1 }` and mean it; the rest is
 * filled in by {@link exited}. Returning nothing means "exited 0, printed
 * nothing", which is the common case.
 */
export type FakeCommandOutcome = Partial<CommandResult> | void

/** Builds a full {@link CommandResult} from however little a test supplied. */
export function exited(outcome: FakeCommandOutcome): CommandResult {
  return {
    exitCode: outcome?.exitCode ?? 0,
    output: outcome?.output ?? '',
    truncated: outcome?.truncated ?? false,
    droppedChars: outcome?.droppedChars ?? 0,
  }
}

export interface FakeRunnerOptions {
  /**
   * Base the control channel lives under — the same URL the page would be
   * served from. `http://127.0.0.1:5199` for the one-shot server,
   * `http://127.0.0.1:5199/s/<id>` for a daemon session.
   */
  url: string
  /**
   * What a command does. Free to write into `fs`, which is how a "build"
   * produces artifacts for {@link FakeRunnerPage} to upload.
   *
   * The default exits 0 and writes nothing — which makes the build step fail
   * with `NoBuildOutput`, exactly as a real tool that cannot spawn its own
   * binary does. That is the right default: a test that wants a successful
   * build has to say what the build produced.
   */
  run?: (
    command: FakeCommand,
    fs: FakeRuntimeFs
  ) => FakeCommandOutcome | Promise<FakeCommandOutcome>
  /**
   * What `installWithCache` reports. Default: a cache hit that installs
   * nothing, since no test here can afford a real install anyway.
   */
  install?: (fs: FakeRuntimeFs) => CacheResult | Promise<CacheResult>
  /**
   * Which package manager the runtime reports. Default: decided from the
   * lockfiles that were actually mounted, like the real one — so a test can
   * check that a pinned manager reaches the build command by mounting a
   * lockfile rather than by stubbing the answer.
   */
  packageManager?: (fs: FakeRuntimeFs) => PackageManagerChoice
}

/** A failure flattened for the control channel, as the page would send it. */
interface WirePayload {
  _tag: string
  message: string
  [field: string]: unknown
}

/**
 * An error the fake reports to the host.
 *
 * Deliberately not built with `core/errors.ts`'s `toWire`. That is the *host's*
 * half of the contract, and this object stands on the page's side of it — using
 * the host's encoder here would let the two drift into agreeing with each other
 * about a format neither of them actually has to parse.
 */
class PageError extends Error {
  constructor(readonly wire: WirePayload) {
    super(wire.message)
  }
}

/**
 * A runner page, running in Node.
 *
 * Attaches to the control channel, announces ready, and answers calls until
 * {@link close}. It does **not** reconnect: a real `EventSource` does, and the
 * grace window that depends on it is already covered in
 * `rpc.integration.test.ts` by dropping a stream on purpose. Adding
 * reconnection here would make every test that closes one wait out the window.
 */
export class FakeRunnerPage {
  /** The runtime's filesystem. Inspect it; that is what it is for. */
  readonly fs = new FakeRuntimeFs()
  /** Every `runCommand` this page was asked to run, in order. */
  readonly commands: FakeCommand[] = []
  /** Every method the host called, in order — including ones it refused. */
  readonly calls: string[] = []
  /**
   * What the runtime had to ask the host for, counted.
   *
   * The control channel is one cost and this is the other, larger one: a call
   * like `mountFromServer` is a single RPC that turns into one request per file
   * behind it. Counting them here is what makes `docs/ROUNDTRIPS.md` a budget
   * something can check rather than a claim.
   */
  readonly requests = { manifest: 0, files: 0, artifacts: 0 }

  private readonly url: string
  private readonly options: FakeRunnerOptions
  private readonly abort = new AbortController()
  private closed = false
  private loop: Promise<void> = Promise.resolve()
  /** Answers still being computed; see {@link serve} for why they overlap. */
  private readonly inFlight = new Set<Promise<void>>()

  private constructor(options: FakeRunnerOptions) {
    this.url = options.url.replace(/\/$/, '')
    this.options = options
  }

  /**
   * Attaches to the control channel and waits until the host would consider the
   * runtime booted.
   *
   * Resolves after the `hello` frame, not merely after the fetch: `hello` is
   * written from inside the stream callback, so seeing it is the only proof
   * that `RunnerLink` has a channel to push calls down. Announcing ready before
   * that would make the ordering luck.
   */
  static async open(options: FakeRunnerOptions): Promise<FakeRunnerPage> {
    const page = new FakeRunnerPage(options)
    await page.attach()
    return page
  }

  private async attach(): Promise<void> {
    const response = await fetch(`${this.url}/api/rpc/events`, {
      signal: this.abort.signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(
        `Fake runner could not attach to ${this.url}: ${response.status}`
      )
    }

    const reader = response.body.getReader()
    const attached = this.readUntilHello(reader)
    await attached
    await this.post('event', { event: 'ready' })
    // Backgrounded on purpose: from here the page answers calls for as long as
    // the host keeps making them, and nothing is waiting on that. A failure in
    // the loop is kept rather than dropped, so `close()` can rethrow it instead
    // of letting the test pass on a page that quietly stopped answering.
    this.loop = this.serve(reader)
  }

  /** Reads frames until the stream's opening `hello`. */
  private async readUntilHello(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      if (buffer.includes('event: hello')) return
      const { value, done } = await reader.read()
      if (done) throw new Error('Control channel closed before it opened')
      buffer += decoder.decode(value, { stream: true })
    }
  }

  /** Answers invocations until the stream ends. */
  private async serve(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const invocation = parseFrame(frame)
        if (invocation) this.startAnswering(invocation)
        boundary = buffer.indexOf('\n\n')
      }

      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        // An aborted fetch is how `close()` ends this, not a failure.
        return
      }
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  /**
   * Begins answering, without waiting for the answer.
   *
   * Calls overlap on a real page and have to overlap here: a `runCommand` with
   * a timeout is killed by a `killCommand` sent **while it is still running**.
   * Answering one at a time would leave that kill queued behind the command it
   * was sent to stop, and the timeout path — the one that decides whether a
   * session is poisoned — would deadlock instead of being tested.
   */
  private startAnswering(invocation: {
    id: number
    method: string
    args: unknown[]
  }): void {
    const answering = this.answer(invocation).catch(() => {
      // `answer` already turns a failure into a wire error; anything reaching
      // here is the POST failing, which `post` treats as the host going away.
    })
    this.inFlight.add(answering)
    void answering.finally(() => this.inFlight.delete(answering))
  }

  private async answer(invocation: {
    id: number
    method: string
    args: unknown[]
  }): Promise<void> {
    this.calls.push(invocation.method)
    try {
      const result = await this.dispatch(invocation.method, invocation.args)
      await this.post('result', { id: invocation.id, ok: true, result })
    } catch (error) {
      await this.post('result', {
        id: invocation.id,
        ok: false,
        error:
          error instanceof PageError
            ? error.wire
            : {
                _tag: 'UnknownFailure',
                message: error instanceof Error ? error.message : String(error),
              },
      })
    }
  }

  private async dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'mountFromServer':
        return this.mountFromServer()
      case 'removePaths':
        return this.removePaths(args[0] as string[])
      case 'resolvePackageManager':
        return this.resolvePackageManager()
      case 'installWithCache':
        return this.installWithCache()
      case 'runCommand':
        return this.runCommand(
          args[0] as string,
          args[1] as string[],
          (args[2] ?? {}) as RunCommandOptions
        )
      case 'uploadDist':
        return this.uploadDist((args[0] as string) ?? '/dist')
      case 'writeFile':
        this.fs.write(args[0] as string, args[1] as string)
        return undefined
      case 'describeRuntime':
        return { workdir: '/', path: '/usr/local/bin:/usr/bin:/bin' }
      case 'clearCache':
        return { removed: [], bytes: 0 } satisfies ClearCacheResult
      case 'killCommand':
        // Nothing runs long enough here to kill, and saying `true` would claim
        // a race was won that never happened.
        return false
      default:
        // Named rather than ignored. The host turns an unrecognised tag into an
        // `UnknownFailure` keeping this one, which is how a test can tell "the
        // page does not implement that" from "the call failed".
        throw new PageError({
          _tag: 'RuntimeFailure',
          operation: method,
          message: `The fake runner does not implement ${method}`,
        })
    }
  }

  /** Pulls the whole project through the host's routes, like the page does. */
  private async mountFromServer(): Promise<number> {
    this.requests.manifest++
    const manifest = await fetch(`${this.url}/api/files`)
    if (!manifest.ok) {
      throw new PageError({
        _tag: 'MountFailed',
        path: 'api/files',
        message: `Failed to fetch file manifest: ${manifest.status}`,
      })
    }

    const paths = (await manifest.json()) as string[]
    for (const relPath of paths) {
      this.requests.files++
      const file = await fetch(
        `${this.url}/api/files/raw?path=${encodeURIComponent(relPath)}`
      )
      if (!file.ok) {
        throw new PageError({
          _tag: 'MountFailed',
          path: relPath,
          message: `Failed to fetch file ${relPath}: ${file.status}`,
        })
      }
      this.fs.write(`/${relPath}`, new Uint8Array(await file.arrayBuffer()))
    }
    return paths.length
  }

  private removePaths(paths: string[]): number {
    for (const path of paths) this.fs.remove(path)
    return paths.length
  }

  private resolvePackageManager(): PackageManagerChoice {
    if (this.options.packageManager) return this.options.packageManager(this.fs)
    return defaultPackageManager(this.fs)
  }

  private async installWithCache(): Promise<CacheResult> {
    if (this.options.install) return this.options.install(this.fs)
    return { cached: true, key: 'fake-lockfile-hash' }
  }

  private async runCommand(
    cmd: string,
    args: string[],
    options: RunCommandOptions
  ): Promise<CommandResult> {
    const command: FakeCommand = { cmd, args, options }
    this.commands.push(command)
    if (!this.options.run) return exited(undefined)
    return exited(await this.options.run(command, this.fs))
  }

  /**
   * Walks the output and POSTs each file back, including the check that gives
   * `NoBuildOutput` its reason to exist: a build that exits 0 and writes
   * nothing is a different claim from a build that failed.
   */
  private async uploadDist(distPath: string): Promise<number> {
    if (!this.fs.exists(distPath)) {
      throw new PageError({
        _tag: 'NoBuildOutput',
        distPath,
        message:
          `The build reported success but produced no output at ${distPath}. ` +
          'Check the build log above — a tool that fails to start can still exit 0.',
      })
    }

    let count = 0
    for (const absolute of this.fs.paths(distPath)) {
      const relative = absolute
        .slice(normalize(distPath).length)
        .replace(/^\//, '')
      const body = this.fs.readBytes(absolute)!
      this.requests.artifacts++
      const response = await fetch(
        `${this.url}/api/dist?path=${encodeURIComponent(relative)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: body as unknown as BodyInit,
        }
      )
      if (!response.ok) {
        throw new PageError({
          _tag: 'UploadFailed',
          path: relative,
          status: response.status,
          message: `Failed to upload ${relative}: ${response.status}`,
        })
      }
      count++
    }
    return count
  }

  private async post(route: 'result' | 'event', body: unknown): Promise<void> {
    if (this.closed) return
    await fetch(`${this.url}/api/rpc/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // The host going away mid-answer is a normal end, not a failure: it is
      // what a tab outliving `daemon stop` looks like from this side.
    })
  }

  /**
   * Detaches, the way closing the tab would.
   *
   * The host sees the stream drop and starts its grace window; nothing here
   * reconnects, so after the window the link reports the page gone.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    // The read loop only. An answer still in flight is deliberately not waited
    // on: a command that models one that never returns — which is the whole
    // point of the timeout path — would never let go.
    await this.loop
  }
}

/** Parses one SSE frame, returning an invocation or `null` for anything else. */
function parseFrame(
  frame: string
): { id: number; method: string; args: unknown[] } | null {
  const lines = frame.split('\n')
  // A named event is never an invocation — `hello` carries the reconnect delay
  // and a real `EventSource` would not hand it to `onmessage` either.
  if (lines.some((line) => line.startsWith('event:'))) return null

  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('')
  if (!data) return null

  return JSON.parse(data) as { id: number; method: string; args: unknown[] }
}

/**
 * Picks a manager from the lockfiles that were actually mounted.
 *
 * Not a full copy of the runner's rules — it does not read `packageManager`
 * from `package.json`, which is where a pinned version comes from. A test about
 * pinning should supply {@link FakeRunnerOptions.packageManager} and say so,
 * rather than trusting a half-implementation to agree with the real one.
 */
function defaultPackageManager(fs: FakeRuntimeFs): PackageManagerChoice {
  const manager = fs.has('/pnpm-lock.yaml')
    ? 'pnpm'
    : fs.has('/yarn.lock')
      ? 'yarn'
      : 'npm'
  return {
    manager,
    reason: `${manager} lockfile`,
    command: manager,
    argsPrefix: [],
    note: 'resolved by the fake runner from the mounted lockfiles',
  }
}
