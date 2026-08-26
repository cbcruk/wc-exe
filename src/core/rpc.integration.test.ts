import { describe, expect, it, afterEach } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { startServer, createApp, type ServerInfo } from './server.js'
import { RunnerLink } from './rpc.js'

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
 *
 * The disconnect tests matter for the same reason as the flush test. Now that
 * the host does not own the browser, a closed tab is not a protocol error it
 * can observe — it is a stream that simply stops. Whether that is noticed is a
 * property of the socket, so it has to be checked on one.
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
    // `.+`, not `.*`: the stream opens with a named `hello` carrying an empty
    // data line to set the reconnect delay. A real `EventSource` never hands
    // that to `onmessage` — this stand-in has to skip it by hand.
    const match = buffer.match(/data: (.+)\n/)
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

/**
 * A link on a real socket with a grace window short enough to wait on.
 *
 * Built by hand rather than through `startServer` so the window is settable:
 * the production three seconds would put a multi-second sleep in every test
 * below, and the behaviour under test is the window, not its length.
 */
async function linkOnSocket(graceMs: number): Promise<{
  link: RunnerLink
  url: string
  server: ServerType
}> {
  const link = new RunnerLink({ graceMs })
  const app = createApp(
    { listFiles: async () => [], readFile: async () => new Uint8Array() },
    link
  )
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s)
    )
  })
  const { port } = server.address() as { port: number }
  return { link, url: `http://127.0.0.1:${port}`, server }
}

/** Streams opened by the test, so teardown can drop the ones it left open. */
const openStreams: Array<() => Promise<void>> = []

/** Opens the event stream and returns a handle that can drop it. */
async function openStream(url: string): Promise<{ drop: () => Promise<void> }> {
  const response = await fetch(`${url}/api/rpc/events`)
  const reader = response.body!.getReader()
  // One read so the handler has certainly run and installed its push.
  void reader.read()
  const drop = (): Promise<void> => reader.cancel()
  openStreams.push(drop)
  return { drop }
}

describe('a runner page that goes away', () => {
  let server: ServerType | undefined

  afterEach(async () => {
    // An SSE response is a connection that never ends on its own, so a stream
    // the test deliberately left open would hold `close()` forever.
    await Promise.all(
      openStreams.splice(0).map((drop) => drop().catch(() => {}))
    )
    if (server) {
      const s = server
      // `close()` stops accepting but waits on live sockets, and fetch leaves
      // keep-alive connections behind — without this each teardown stalls until
      // Node times them out, which is seconds per test for nothing.
      ;(s as { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolve) => s.close(() => resolve()))
      server = undefined
    }
  })

  it('fails calls left in flight once the grace window passes', async () => {
    const socket = await linkOnSocket(50)
    server = socket.server

    const stream = await openStream(socket.url)
    const pending = socket.link.call('runCommand', ['npm', ['run', 'build']])
    await stream.drop()

    await expect(pending).rejects.toThrow(/went away/)
  })

  it('keeps calls pending when the stream comes back inside the window', async () => {
    // EventSource reconnects on its own, so this is the common case, not the
    // exotic one — a link that failed on the first abort would break every
    // build that outlived a network hiccup.
    const socket = await linkOnSocket(600)
    server = socket.server

    const first = await openStream(socket.url)
    const pending = socket.link.call('runCommand', ['npm', ['run', 'build']])
    await first.drop()

    // The pause is what gives this test teeth. Reconnecting immediately proves
    // nothing: the new stream lands within a millisecond, so it clears the
    // timer whether the window is 600ms or zero, and the test passes either
    // way. Waiting first puts the reconnect unambiguously after the abort and
    // inside the window, which only one of those two survives. A real
    // `EventSource` pauses too — see `RECONNECT_MS`.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await openStream(socket.url)

    const settled = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 800)),
    ])
    expect(settled).toBe('pending')
  })

  it('makes the next page announce ready for itself', async () => {
    // A link that remembered the first page's `ready` would report a booted
    // runtime the moment a second tab opened, before that tab had booted one.
    const socket = await linkOnSocket(50)
    server = socket.server

    const stream = await openStream(socket.url)
    await fetch(`${socket.url}/api/rpc/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'ready' }),
    })
    await expect(socket.link.waitForReady(1000)).resolves.toBeUndefined()

    const gone = new Promise<void>((resolve) =>
      socket.link.onDisconnect(resolve)
    )
    await stream.drop()
    await gone

    await expect(socket.link.waitForReady(150)).rejects.toThrow(
      /did not report ready/
    )
  })
})

describe('letting go of a page', () => {
  let server: ServerType | undefined

  afterEach(async () => {
    await Promise.all(
      openStreams.splice(0).map((drop) => drop().catch(() => {}))
    )
    if (server) {
      const s = server
      ;(s as { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolve) => s.close(() => resolve()))
      server = undefined
    }
  })

  it('ends the open event stream when the link closes', async () => {
    // The host cannot ask the page to let go — the page is in a browser it does
    // not own. So closing has to end the response from this side, or the
    // session's socket outlives the session that justified it.
    const socket = await linkOnSocket(50)
    server = socket.server

    const response = await fetch(`${socket.url}/api/rpc/events`)
    const reader = response.body!.getReader()
    void reader.read()

    socket.link.close('done')

    // Resolves only if the response actually ended; an SSE stream that is
    // merely abandoned leaves this pending forever.
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return 'ended'
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 2000)),
    ])
    expect(ended).toBe('ended')
  })

  it('refuses a stream on a closed link instead of holding one open', async () => {
    // `EventSource` reconnects on its own, so ending the stream is not the end
    // of it: a tab whose session the daemon evicted would attach again and hold
    // a socket for a session that no longer exists. 204 is the status the spec
    // treats as fatal, so the tab stops retrying rather than doing it forever.
    const socket = await linkOnSocket(50)
    server = socket.server

    socket.link.close('done')
    const response = await fetch(`${socket.url}/api/rpc/events`)

    expect(response.status).toBe(204)
  })
})
