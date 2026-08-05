import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolveRunnerDist } from './runner-assets.js'
import type { ServerHandlers } from './types.js'

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer
}

/**
 * Builds the Hono app that backs the runner page.
 *
 * It serves the built runner bundle plus the `/api` routes the runner calls to
 * pull project files and push build artifacts back to the host. Every response
 * carries the COEP/COOP headers that cross-origin isolation — and therefore
 * WebContainer — requires.
 *
 * @param handlers Host-side filesystem callbacks backing the `/api` routes.
 */
export function createApp(handlers: ServerHandlers): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.header('Cross-Origin-Embedder-Policy', 'require-corp')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
  })

  app.get('/api/files', async (c) => {
    return c.json(await handlers.listFiles())
  })

  app.get('/api/files/raw', async (c) => {
    const relPath = c.req.query('path')
    if (!relPath) return c.text('Missing path', 400)

    try {
      const data = await handlers.readFile(relPath)
      return new Response(toArrayBuffer(data), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    } catch {
      return c.text(`File not found: ${relPath}`, 404)
    }
  })

  app.post('/api/dist', async (c) => {
    if (!handlers.writeDistFile) return c.text('Dist upload not supported', 501)

    const relPath = c.req.query('path')
    if (!relPath) return c.text('Missing path', 400)

    const data = new Uint8Array(await c.req.arrayBuffer())
    await handlers.writeDistFile(relPath, data)
    return c.body(null, 204)
  })

  app.use('/*', serveStatic({ root: resolveRunnerDist() }))

  return app
}

/** A running local server, as returned by {@link startServer}. */
export interface ServerInfo {
  /** Underlying Node server handle. Close it to shut the server down. */
  server: ServerType
  /** Port actually bound — resolved, never `0`. */
  port: number
  /** Origin the runner page is served from, e.g. `http://localhost:5199`. */
  url: string
}

/**
 * Starts the runner server and resolves once it is listening.
 *
 * @param handlers Host-side filesystem callbacks backing the `/api` routes.
 * @param port Port to bind. `0` (the default) picks a free one.
 * @returns Rejects if the port is unavailable or the server fails to start.
 */
export function startServer(
  handlers: ServerHandlers,
  port: number = 0
): Promise<ServerInfo> {
  return new Promise((resolve, reject) => {
    try {
      const app = createApp(handlers)
      const server = serve(
        {
          fetch: app.fetch,
          port,
          // 127.0.0.1 only. These routes hand out the project's source files,
          // so binding every interface published the user's code to the local
          // network for the duration of the build. It also made a port clash
          // undetectable: binding INADDR_ANY can succeed while another process
          // already holds 127.0.0.1 on the same port, after which requests land
          // on whichever got there first.
          hostname: '127.0.0.1',
        },
        (info) => {
          resolve({
            server,
            port: info.port,
            // 127.0.0.1, not `localhost`. OPFS is keyed by origin as a
            // string, so the two are different stores even though they reach
            // the same server — the daemon and this path would each keep their
            // own node_modules cache and neither could use the other's. It also
            // avoids `localhost` resolving to ::1 while we listen on IPv4.
            url: `http://127.0.0.1:${info.port}`,
          })
        }
      )

      server.on('error', reject)
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Starts the server on a fixed port, falling back to a random one if it is
 * taken.
 *
 * The fixed port matters because OPFS — where the `node_modules` cache lives —
 * is scoped per origin (scheme+host+port). On the fallback path the cache is
 * simply unreachable; the run still succeeds, it just installs from scratch.
 *
 * @param handlers Host-side filesystem callbacks backing the `/api` routes.
 * @param preferredPort Port that keeps the origin — and thus the cache — stable.
 * @returns The running server, and `stablePort: false` when the preferred port
 *   was unavailable and callers should treat the cache as disabled.
 */
export async function startServerWithFallback(
  handlers: ServerHandlers,
  preferredPort: number
): Promise<{ info: ServerInfo; stablePort: boolean }> {
  try {
    return {
      info: await startServer(handlers, preferredPort),
      stablePort: true,
    }
  } catch {
    return { info: await startServer(handlers, 0), stablePort: false }
  }
}
