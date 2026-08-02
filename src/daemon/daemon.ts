import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import fs from 'node:fs'
import path from 'node:path'
import type { Browser } from 'puppeteer-core'
import {
  CACHE_PORT,
  CHROME_PROFILE_DIR,
  ensureCacheDirs,
} from '../core/cache.js'
import { launchChrome } from '../core/chrome.js'
import { resolveRunnerDist } from '../core/runner-assets.js'
import { controlPlaneGuard } from './auth.js'
import { createToken, writeRecord, clearRecord } from './discovery.js'
import { Session, sessionKey } from './session.js'
import { VERSION } from '../version.js'

/** Shut down after this long with no requests. */
const DEFAULT_IDLE_MS = 10 * 60 * 1000

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer
}

/** A running daemon. */
export interface RunningDaemon {
  port: number
  token: string
  close: () => Promise<void>
}

/**
 * Rejects a project path the daemon should not touch.
 *
 * The control plane is already behind a token, so this is a second layer: it
 * bounds the damage if that token ever leaks, by refusing to build somewhere
 * that is not a real directory the caller could name.
 */
function resolveProject(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('source must be a non-empty path')
  }

  const resolved = path.resolve(source)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`No such directory: ${resolved}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`)
  }
  return resolved
}

/**
 * Starts the daemon.
 *
 * Binds **127.0.0.1 only**. Binding `0.0.0.0` would expose a build-running
 * service to the whole network, and nothing here needs to be reachable off this
 * machine.
 */
export async function startDaemon(
  options: { port?: number; idleMs?: number; verbose?: boolean } = {}
): Promise<RunningDaemon> {
  ensureCacheDirs()

  // Fail here, loudly, rather than serving 404s for every asset and leaving the
  // page to time out sixty seconds later with no explanation.
  const runnerPath = resolveRunnerDist()

  const token = createToken()
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const sessions = new Map<string, Session>()
  // Monotonic, so an id is never reused after a session is evicted — the page
  // URL carries it, and a recycled id could route one project's files to
  // another's page.
  let nextSessionId = 0

  let server: ServerType | undefined
  let closing = false

  // One browser for every session. Chrome allows a single process per profile
  // directory and aborts rather than risk corrupting it, so a browser per
  // session made the second project fail before it began. Launched on first use
  // and memoised, so concurrent sessions await the same launch rather than
  // racing to start two.
  let browserPromise: Promise<Browser> | null = null
  const getBrowser = (): Promise<Browser> => {
    browserPromise ??= launchChrome({ userDataDir: CHROME_PROFILE_DIR })
    return browserPromise
  }
  let lastActivity = Date.now()
  const touch = (): void => {
    lastActivity = Date.now()
  }

  const app = new Hono()

  // ---- runner plane: one session per path, on the daemon's own origin ------

  const sessionFor = (id: string): Session | undefined =>
    [...sessions.values()].find((session) => session.id === id)

  app.use('/s/:id/*', async (c, next) => {
    // WebContainer needs cross-origin isolation on every response the page
    // touches, including its assets.
    await next()
    c.header('Cross-Origin-Embedder-Policy', 'require-corp')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
  })

  app.get('/s/:id/api/files', async (c) => {
    const session = sessionFor(c.req.param('id'))
    if (!session) return c.text('Unknown session', 404)
    touch()
    return c.json(await session.handlers().listFiles())
  })

  app.get('/s/:id/api/files/raw', async (c) => {
    const session = sessionFor(c.req.param('id'))
    if (!session) return c.text('Unknown session', 404)
    const relPath = c.req.query('path')
    if (!relPath) return c.text('Missing path', 400)
    touch()
    try {
      const data = await session.handlers().readFile(relPath)
      return new Response(toArrayBuffer(data), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    } catch {
      return c.text(`File not found: ${relPath}`, 404)
    }
  })

  app.post('/s/:id/api/dist', async (c) => {
    const session = sessionFor(c.req.param('id'))
    if (!session) return c.text('Unknown session', 404)
    const relPath = c.req.query('path')
    if (!relPath) return c.text('Missing path', 400)
    touch()
    const data = new Uint8Array(await c.req.arrayBuffer())
    await session.handlers().writeDistFile!(relPath, data)
    return c.body(null, 204)
  })

  // The runner bundle is built with a relative base, so the same files serve
  // correctly under every session prefix.
  app.use('/s/:id/*', async (c, next) => {
    const id = c.req.param('id')
    return serveStatic({
      root: runnerPath,
      rewriteRequestPath: (p) => p.replace(`/s/${id}`, '') || '/',
    })(c, next)
  })

  // ---- control plane: CLI only --------------------------------------------

  app.use('/control/*', controlPlaneGuard(token))

  app.get('/control/health', (c) => {
    touch()
    return c.json({
      version: VERSION,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      idleMs,
      sessions: [...sessions.values()].map((session) => ({
        id: session.id,
        source: session.source,
        lastUsedAt: new Date(session.lastUsedAt).toISOString(),
        poisoned: session.poisonedReason,
      })),
    })
  })

  app.post('/control/build', async (c) => {
    touch()
    const body = await c.req.json().catch(() => ({}))

    let source: string
    try {
      source = resolveProject(body.source)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }

    const key = sessionKey(source)
    let session = sessions.get(key)

    // A session that failed mid-build cannot be characterised, so it is
    // replaced rather than reused. Correctness beats the saved boot.
    if (session?.poisonedReason) {
      await session.close()
      sessions.delete(key)
      session = undefined
    }

    if (body.fresh && session) {
      await session.close()
      sessions.delete(key)
      session = undefined
    }

    if (!session) {
      session = new Session(`${nextSessionId++}-${Date.now().toString(36)}`, {
        source,
        origin: `http://127.0.0.1:${port}`,
        getBrowser,
      })
      sessions.set(key, session)
    }

    const logs: string[] = []
    try {
      const result = await session.build({
        output: path.resolve(String(body.output ?? './dist')),
        distDir: String(body.distDir ?? '/dist'),
        noInstall: Boolean(body.noInstall),
        verbose: Boolean(options.verbose),
        timeout: typeof body.timeout === 'number' ? body.timeout : undefined,
        onLog: (line) => logs.push(line),
      })
      touch()
      return c.json({ ok: true, logs, ...result })
    } catch (error) {
      touch()
      return c.json({ ok: false, logs, error: (error as Error).message }, 500)
    }
  })

  app.post('/control/stop', (c) => {
    // Reply before tearing down, so the caller sees an answer rather than a
    // dropped connection.
    setTimeout(() => void shutdown(), 50)
    return c.json({ ok: true })
  })

  // ---- listen --------------------------------------------------------------

  const port = await new Promise<number>((resolve, reject) => {
    server = serve(
      {
        fetch: app.fetch,
        port: options.port ?? CACHE_PORT,
        hostname: '127.0.0.1',
      },
      (info) => resolve(info.port)
    )
    server.on('error', reject)
  })

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs) void shutdown()
  }, 30_000)
  // Do not hold the process open on the idle check alone.
  idleTimer.unref?.()

  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    clearInterval(idleTimer)
    for (const session of sessions.values()) await session.close()
    sessions.clear()
    // Sessions only close their own pages, so the shared browser is the
    // daemon's to shut down.
    if (browserPromise) {
      await browserPromise
        .then((browser) => browser.close())
        .catch(() => undefined)
      browserPromise = null
    }
    clearRecord()
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
  }

  writeRecord({
    pid: process.pid,
    port,
    token,
    version: VERSION,
    startedAt: new Date().toISOString(),
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown().then(() => process.exit(0))
    })
  }

  return { port, token, close: shutdown }
}
