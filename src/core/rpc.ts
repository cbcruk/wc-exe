import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'

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

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
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
  private readyPromise: Promise<void>
  private closed = false

  constructor() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })
  }

  /**
   * Resolves once the page has connected and reported that its runtime booted.
   *
   * Replaces waiting on a `window.__WC_READY__` flag through CDP: the page says
   * so itself, which is the only way it can work when the host did not open it.
   */
  waitForReady(timeoutMs = 60_000): Promise<void> {
    return Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
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
      ),
    ])
  }

  /** Calls a method on the page's `wcRunner` and waits for its result. */
  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('Runner link is closed'))
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
    return streamSSE(c, async (stream) => {
      this.push = (message) => {
        void stream.writeSSE({ data: JSON.stringify(message) })
      }
      for (const message of this.queue.splice(0)) this.push(message)

      // The stream stays open for the life of the page; resolving would end it
      // and the page would reconnect for nothing.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          this.push = null
          resolve()
        })
      })
    })
  }

  /** Route handler: `POST …/api/rpc/result`. */
  async result(c: Context): Promise<Response> {
    const body = (await c.req.json()) as {
      id: number
      ok: boolean
      result?: unknown
      error?: string
    }
    const pending = this.pending.get(body.id)
    if (!pending) return c.text('unknown call id', 404)
    this.pending.delete(body.id)
    if (body.ok) pending.resolve(body.result)
    else pending.reject(new Error(body.error ?? 'Runner call failed'))
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
   * Fails every outstanding call.
   *
   * Without this a host shutting down while a command is in flight would hang
   * on a promise nothing can settle any more.
   */
  close(reason = 'Runner link closed'): void {
    this.closed = true
    for (const pending of this.pending.values())
      pending.reject(new Error(reason))
    this.pending.clear()
    this.push = null
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
