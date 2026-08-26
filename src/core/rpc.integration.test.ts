import { describe, expect, it, afterEach } from 'vitest'
import { startServer, type ServerInfo } from './server.js'

/**
 * The unit tests drive the link through Hono's app object, which never touches
 * a socket. This runs the same exchange over the real one.
 *
 * That matters because the riskiest unknown in this transport is not the
 * protocol — it is whether `streamSSE` actually flushes through
 * `@hono/node-server` rather than buffering until the response ends. A stream
 * that buffers would look perfect in a unit test and hang in production, which
 * is the failure this repository keeps finding in other shapes.
 *
 * The page's half still cannot be tested here: WebContainer does not boot in
 * this sandbox, so nothing can open the runner for real.
 */

let running: ServerInfo | undefined

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running!.server.close(() => resolve()))
    running = undefined
  }
})

/** Minimal stand-in for the page: reads one invocation, posts one result. */
async function fakePage(url: string, respond: (method: string) => unknown) {
  const events = await fetch(`${url}/api/rpc/events`)
  const reader = events.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const match = buffer.match(/data: (.*)\n/)
    if (match) {
      const { id, method } = JSON.parse(match[1])
      await fetch(`${url}/api/rpc/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ok: true, result: respond(method) }),
      })
      await reader.cancel()
      return
    }
    const { value, done } = await reader.read()
    if (done) throw new Error('event stream closed before delivering a call')
    buffer += decoder.decode(value, { stream: true })
  }
}

describe('the control channel over a real socket', () => {
  it('delivers a call and its result through @hono/node-server', async () => {
    running = await startServer({
      listFiles: async () => [],
      readFile: async () => new Uint8Array(),
    })

    const pending = running.link.call<string>('describeRuntime', [])
    await fakePage(running.url, (method) => `handled:${method}`)

    expect(await pending).toBe('handled:describeRuntime')
  })

  it('reaches the page even when the call was made before it connected', async () => {
    running = await startServer({
      listFiles: async () => [],
      readFile: async () => new Uint8Array(),
    })

    // No stream open yet — this is the startup gap the queue exists for.
    const pending = running.link.call<number>('mountFromServer', [])
    await fakePage(running.url, () => 7)

    expect(await pending).toBe(7)
  })

  it('resolves waitForReady from a POST the page sends', async () => {
    running = await startServer({
      listFiles: async () => [],
      readFile: async () => new Uint8Array(),
    })

    const waiting = running.link.waitForReady(5000)
    await fetch(`${running.url}/api/rpc/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'ready' }),
    })
    await expect(waiting).resolves.toBeUndefined()
  })
})
