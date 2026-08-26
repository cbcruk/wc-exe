/**
 * The page's half of the control channel.
 *
 * The host used to reach in through Puppeteer and call `window.wcRunner`
 * directly. Here the page listens instead: it holds an `EventSource` open,
 * runs whatever method the host names, and posts the result back. The API is
 * unchanged — this only swaps how a call arrives — but it means a page the
 * host did not launch can be driven the same way.
 *
 * See `src/core/rpc.ts` for the other half and for why SSE rather than a
 * WebSocket.
 */

interface Invocation {
  id: number
  method: string
  args: unknown[]
}

type Api = Record<string, (...args: never[]) => unknown>

/**
 * @param api The object whose methods the host may call — `wcRunner`.
 * @param apiUrl Resolves a route against the page's own directory, so the same
 *   bundle works whether it is mounted at `/` or at a daemon session path.
 */
export function connectControlChannel(
  api: Api,
  apiUrl: (path: string) => string
): {
  announceReady: () => void
  emit: (event: string, payload?: unknown) => void
} {
  const post = (path: string, body: unknown) =>
    void fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // The page may be navigating away when a shell chunk goes out; without
      // this the browser can cancel the request and the host loses output.
      keepalive: true,
    }).catch(() => {
      // A host that has gone away is not this page's problem to report.
    })

  const source = new EventSource(apiUrl('api/rpc/events'))

  source.onmessage = async (message) => {
    const { id, method, args } = JSON.parse(message.data) as Invocation
    const fn = api[method]
    if (typeof fn !== 'function') {
      // Named rather than ignored: a method the host has and the page does not
      // means the two halves are out of step, and silence would present as the
      // call hanging.
      post('api/rpc/result', {
        id,
        ok: false,
        error: `Runner has no method "${method}"`,
      })
      return
    }
    try {
      const result = await (fn as (...a: unknown[]) => unknown)(...args)
      post('api/rpc/result', { id, ok: true, result })
    } catch (error) {
      post('api/rpc/result', {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    announceReady: () => post('api/rpc/event', { event: 'ready' }),
    emit: (event, payload) => post('api/rpc/event', { event, payload }),
  }
}
