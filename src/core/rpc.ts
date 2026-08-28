import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import { fromWire, RunnerGone, type WireError } from './errors.js'

/**
 * The control channel between the host and the runner page.
 *
 * The host used to drive the page over Puppeteer's CDP connection: every method
 * on `WCBrowser` was a `page.evaluate()` with an inline function serialised
 * into the page. That works, but it means the control path can only exist while
 * the host is the one that launched the browser — and it costs a Chrome binary
 * the host has to locate, plus a function-through-a-string boundary with no
 * type checking across it.
 *
 * This is the same calls over HTTP instead, so a page the host did not launch
 * can drive itself just as well.
 *
 * **Server-sent events one way, POST the other**, rather than a WebSocket:
 * Hono ships SSE, so this adds no dependency, and every message is
 * curl-visible. It is enough because nothing streams — `runCommand` returns its
 * output in the result, and the `shell*` methods that would stream have no
 * caller. If one ever does, `event()` below is where the page pushes and the
 * shape does not have to change.
 */

/**
 * Reconnection delay handed to the page's `EventSource`, in milliseconds.
 *
 * Must stay comfortably under {@link RunnerLink}'s grace window, which is what
 * decides how long a dropped stream has to come back before the page counts as
 * gone. Left to the browser's default the two numbers are both about three
 * seconds and the ordering is luck.
 */
const RECONNECT_MS = 1_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * What the page posts back for a call.
 *
 * `error` is a {@link WireError} object. It used to be a bare string, and a
 * string is still accepted: {@link fromWire} turns one into an
 * `UnknownFailure` carrying it. That path is not decoration — the daemon holds
 * a *booted* page bundle, and although `ensureDaemon` restarts it on a version
 * mismatch, a tab a user left open from an older build can still answer.
 */
interface CallResult {
  id: number
  ok: boolean
  result?: unknown
  error?: WireError | string
}

/** What the host sends down the event stream. */
interface Invocation {
  id: number
  method: string
  args: unknown[]
}

export class RunnerLink {
  private pending = new Map<number, Pending>()
  private sequence = 0
  private queue: Invocation[] = []
  private push: ((message: Invocation) => void) | null = null
  private listeners = new Map<string, (payload: unknown) => void>()
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyPromise!: Promise<void>
  private closed = false
  /** Listeners for "the page stopped being there"; see {@link onDisconnect}. */
  private disconnectListeners = new Set<() => void>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  /** Ends the open event stream; see {@link close}. */
  private endStream: (() => void) | null = null

  /**
   * How long a dropped stream is given to come back before the page counts as
   * gone.
   *
   * `EventSource` reconnects on its own, so an abort is not by itself a closed
   * tab — it is also what a laptop waking up looks like. Treating the first
   * abort as a closed tab would tear down a session that is about to be fine.
   *
   * Three seconds against the {@link RECONNECT_MS} the page is told to use.
   */
  private readonly graceMs: number

  /**
   * @param options.graceMs Override the reconnect grace window. Exists so tests
   *   can exercise the window in milliseconds instead of seconds; three seconds
   *   is the number that matters in practice.
   */
  constructor(options: { graceMs?: number } = {}) {
    this.graceMs = options.graceMs ?? 3_000
    this.armReady()
  }

  /**
   * Points {@link waitForReady} at a fresh promise.
   *
   * Re-armed rather than resolved once for all time, because the link outlives
   * any one page: when a tab closes and the next one opens on the same session,
   * the host has to wait for *that* page's boot, not remember the last one's.
   */
  private armReady(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // The promise is only awaited if someone calls waitForReady. Without this,
    // a rejection with no waiter is an unhandled rejection.
    this.readyPromise.catch(() => undefined)
  }

  /**
   * Registers interest in the page going away.
   *
   * The daemon uses this: a closed tab is a far better signal that a session is
   * over than an idle timer guessing at it.
   */
  onDisconnect(listener: () => void): void {
    this.disconnectListeners.add(listener)
  }

  /** Whether a page currently holds the event stream open. */
  get isConnected(): boolean {
    return this.push !== null
  }

  /**
   * Resolves once the page has connected and reported that its runtime booted.
   *
   * Replaces waiting on a `window.__WC_READY__` flag through CDP: the page says
   * so itself, which is the only way it can work when the host did not open it.
   */
  waitForReady(timeoutMs = 60_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Runner did not report ready within ${timeoutMs}ms. ` +
                'Is the page open, and does this browser support ' +
                'SharedArrayBuffer under cross-origin isolation?'
            )
          ),
        timeoutMs
      )
    })
    // Cleared rather than left to fire: the daemon holds a link for as long as
    // the session lives, and an uncleared timer per boot keeps the process
    // awake and accumulates.
    return Promise.race([this.readyPromise, deadline]).finally(() =>
      clearTimeout(timer)
    )
  }

  /** Calls a method on the page's `wcRunner` and waits for its result. */
  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new RunnerGone({
          reason: 'the link was closed',
          message: 'Runner link is closed',
        })
      )
    }
    const id = ++this.sequence
    const message: Invocation = { id, method, args }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      if (this.push) this.push(message)
      // Queued rather than dropped: `call()` can legitimately land in the gap
      // between the server starting and the page connecting, and failing there
      // would make startup order load-bearing.
      else this.queue.push(message)
    })
  }

  /** Subscribes to an event the page pushes, e.g. shell output. */
  onEvent(name: string, listener: (payload: unknown) => void): void {
    this.listeners.set(name, listener)
  }

  /** Route handler: `GET …/api/rpc/events`. Holds the stream open. */
  events(c: Context): Response | Promise<Response> {
    // A closed link serves no streams. Ending the open one is not enough:
    // `EventSource` reconnects, so between {@link close} and the server
    // actually shutting down the page would attach again and hold the socket
    // open forever — which is a hang, not a leak.
    //
    // **204, deliberately.** The EventSource spec treats any status other than
    // 200 as fatal and stops reconnecting, so this also tells the tab to give
    // up rather than retry a host that has gone.
    if (this.closed) return c.body(null, 204)

    return streamSSE(c, async (stream) => {
      // A stream arriving inside the grace window is the same page reconnecting,
      // so the pending calls it left behind are still its own to answer.
      if (this.graceTimer) {
        clearTimeout(this.graceTimer)
        this.graceTimer = null
      }

      // Pin the browser's reconnection delay rather than take its default.
      // Chrome's is about three seconds — the same as the grace window below —
      // so the two would race, and a transient drop would be a coin flip
      // between "it came back" and "the tab is gone". A named event so the
      // page's `onmessage`, which expects an invocation, never sees it.
      await stream.writeSSE({ event: 'hello', data: '', retry: RECONNECT_MS })

      this.push = (message) => {
        void stream.writeSSE({ data: JSON.stringify(message) })
      }
      for (const message of this.queue.splice(0)) this.push(message)

      // The stream stays open for the life of the page; resolving would end it
      // and the page would reconnect for nothing. The one exception is
      // {@link close} — see there for why the host must be able to end it.
      await new Promise<void>((resolve) => {
        this.endStream = resolve
        stream.onAbort(() => {
          this.push = null
          if (!this.closed) {
            this.graceTimer = setTimeout(() => this.handleGone(), this.graceMs)
            this.graceTimer.unref?.()
          }
          resolve()
        })
      })
    })
  }

  /**
   * The page did not come back: give up on it.
   *
   * Outstanding calls are failed rather than left pending. Under Puppeteer a
   * dead page surfaced as a protocol error; here nothing surfaces at all, so a
   * build whose tab was closed mid-run would simply never return.
   */
  private handleGone(): void {
    this.graceTimer = null
    // Tagged, and tagged as *safe*: the container went with the tab, so there
    // is no half-written state for a later build to inherit. A session that
    // sees this may open a fresh page and carry on.
    const error = new RunnerGone({
      reason: 'tab closed, navigated, or reloaded',
      message:
        'The runner page went away (tab closed, navigated, or reloaded).',
    })
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    // Rejecting a ready promise that already resolved is a no-op; rejecting one
    // that had not is what turns "closed the tab during boot" into an error
    // instead of a sixty-second wait.
    this.readyReject?.(error)
    this.armReady()
    for (const listener of this.disconnectListeners) listener()
  }

  /** Route handler: `POST …/api/rpc/result`. */
  async result(c: Context): Promise<Response> {
    const body = (await c.req.json()) as CallResult
    const pending = this.pending.get(body.id)
    if (!pending) return c.text('unknown call id', 404)
    this.pending.delete(body.id)
    if (body.ok) pending.resolve(body.result)
    // The one place a failure crosses from the page into the host. Everything
    // the runner knew about it — which step, which exit code, the command's
    // output — arrives as fields and stays as fields, instead of being flattened
    // into a sentence that the only remaining reader would have to parse back.
    else pending.reject(fromWire(body.error ?? 'Runner call failed'))
    return c.body(null, 204)
  }

  /** Route handler: `POST …/api/rpc/event`. */
  async event(c: Context): Promise<Response> {
    const body = (await c.req.json()) as { event: string; payload?: unknown }
    if (body.event === 'ready') this.readyResolve?.()
    else this.listeners.get(body.event)?.(body.payload)
    return c.body(null, 204)
  }

  /**
   * Fails every outstanding call and lets go of the page.
   *
   * Two things have to happen, and the second is easy to miss. Failing the
   * pending calls stops a host shutting down mid-command from hanging on a
   * promise nothing can settle. **Ending the event stream stops the host from
   * hanging on the socket.** An SSE response never completes on its own, so
   * `server.close()` waits on it forever — and the host cannot ask the page to
   * let go, because the page is in a browser it does not own. Anything that
   * shuts a server down while a tab is attached — `wc-exe daemon stop`, a
   * benchmark between scenarios — depends on this line.
   */
  close(reason = 'Runner link closed'): void {
    this.closed = true
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    const error = new RunnerGone({ reason, message: reason })
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.readyReject?.(error)
    this.push = null
    this.endStream?.()
    this.endStream = null
  }
}

/** Mounts the three control-channel routes under `prefix`. */
export function mountRpcRoutes(
  app: {
    get: (path: string, handler: (c: Context) => unknown) => unknown
    post: (path: string, handler: (c: Context) => unknown) => unknown
  },
  prefix: string,
  linkFor: (c: Context) => RunnerLink | undefined
): void {
  const missing = (c: Context) => c.text('no runner link for this path', 404)
  app.get(
    `${prefix}/api/rpc/events`,
    (c) => linkFor(c)?.events(c) ?? missing(c)
  )
  app.post(
    `${prefix}/api/rpc/result`,
    (c) => linkFor(c)?.result(c) ?? missing(c)
  )
  app.post(`${prefix}/api/rpc/event`, (c) => linkFor(c)?.event(c) ?? missing(c))
}
