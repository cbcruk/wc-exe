import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerHandlers } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runnerPath = path.resolve(__dirname, '../src/runner/dist')

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer
}

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

  app.use('/*', serveStatic({ root: runnerPath }))

  return app
}

export interface ServerInfo {
  server: ServerType
  port: number
  url: string
}

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
        },
        (info) => {
          resolve({
            server,
            port: info.port,
            url: `http://localhost:${info.port}`,
          })
        }
      )

      server.on('error', reject)
    } catch (error) {
      reject(error)
    }
  })
}
