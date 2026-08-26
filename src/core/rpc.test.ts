import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { RunnerLink, mountRpcRoutes } from './rpc.js'

/**
 * The control channel is the one piece of this that can be exercised without a
 * browser: it is transport, and a fake page is enough to drive it. The build it
 * carries cannot be tested here — WebContainer does not boot in this
 * repository's sandbox — so these cover the transport's own failure modes,
 * which are the ones that would otherwise show up as a hang.
 */

function appFor(link: RunnerLink): Hono {
  const app = new Hono()
  mountRpcRoutes(app, '', () => link)
  return app
}

/** Reads invocations off the SSE stream as they arrive. */
async function openStream(app: Hono) {
  const res = await app.request('/api/rpc/events')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next(): Promise<{ id: number; method: string; args: unknown[] }> {
      for (;;) {
        // `.+`, not `.*`: the stream opens with a named `hello` whose data
        // line is empty, to pin the reconnect delay. A real `EventSource`
        // routes named events away from `onmessage`; this reader skips it.
        const match = buffer.match(/data: (.+)\n/)
        if (match) {
          buffer = buffer.slice(match.index! + match[0].length)
          return JSON.parse(match[1])
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

const reply = (app: Hono, body: unknown) =>
  app.request('/api/rpc/result', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('the runner control channel', () => {
  it('carries a call to the page and its result back', async () => {
    const link = new RunnerLink()
    const app = appFor(link)
    const stream = await openStream(app)

    const pending = link.call<number>('mountFromServer', [])
    const invocation = await stream.next()
    expect(invocation.method).toBe('mountFromServer')

    await reply(app, { id: invocation.id, ok: true, result: 42 })
    expect(await pending).toBe(42)
    await stream.cancel()
  })

  it('rejects with the message the page reported', async () => {
    const link = new RunnerLink()
    const app = appFor(link)
    const stream = await openStream(app)

    const pending = link.call('runCommand', ['npm', ['run', 'build']])
    const invocation = await stream.next()
    await reply(app, { id: invocation.id, ok: false, error: 'install failed' })

    await expect(pending).rejects.toThrow('install failed')
    await stream.cancel()
  })

  it('queues calls made before the page connects', async () => {
    // Startup order would otherwise be load-bearing: the server is up before
    // the page has loaded, and a call landing in that gap must not be lost.
    const link = new RunnerLink()
    const app = appFor(link)

    const pending = link.call<string>('describeRuntime', [])
    const stream = await openStream(app)

    const invocation = await stream.next()
    expect(invocation.method).toBe('describeRuntime')
    await reply(app, { id: invocation.id, ok: true, result: 'ok' })
    expect(await pending).toBe('ok')
    await stream.cancel()
  })

  it('fails outstanding calls when the link closes', async () => {
    // A host shutting down mid-command would otherwise hang on a promise
    // nothing can settle.
    const link = new RunnerLink()
    const app = appFor(link)
    const stream = await openStream(app)

    const pending = link.call('runCommand', [])
    await stream.next()
    link.close('browser went away')

    await expect(pending).rejects.toThrow('browser went away')
    await stream.cancel()
  })

  it('refuses calls once closed rather than queueing them forever', async () => {
    const link = new RunnerLink()
    link.close()
    await expect(link.call('mountFromServer')).rejects.toThrow('closed')
  })

  it('resolves waitForReady when the page reports its runtime booted', async () => {
    const link = new RunnerLink()
    const app = appFor(link)

    let ready = false
    const waiting = link.waitForReady(5000).then(() => {
      ready = true
    })
    expect(ready).toBe(false)

    await app.request('/api/rpc/event', {
      method: 'POST',
      body: JSON.stringify({ event: 'ready' }),
      headers: { 'content-type': 'application/json' },
    })
    await waiting
    expect(ready).toBe(true)
  })

  it('times out waiting for ready instead of hanging', async () => {
    const link = new RunnerLink()
    await expect(link.waitForReady(20)).rejects.toThrow('did not report ready')
  })

  it('delivers page events to their listener', async () => {
    const link = new RunnerLink()
    const app = appFor(link)
    const seen: unknown[] = []
    link.onEvent('shellData', (payload) => seen.push(payload))

    await app.request('/api/rpc/event', {
      method: 'POST',
      body: JSON.stringify({
        event: 'shellData',
        payload: { id: 'a', chunk: 'x' },
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(seen).toEqual([{ id: 'a', chunk: 'x' }])
  })

  it('reports a result for a call it never made', async () => {
    // A stale page reconnecting after a restart would otherwise be silently
    // ignored, which reads as the new call hanging.
    const link = new RunnerLink()
    const app = appFor(link)
    const res = await reply(app, { id: 999, ok: true, result: null })
    expect(res.status).toBe(404)
  })
})
