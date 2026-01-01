import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runnerPath = path.resolve(__dirname, '../src/runner/dist')

export function createApp(): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.header('Cross-Origin-Embedder-Policy', 'require-corp')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
  })

  app.use('/*', serveStatic({ root: runnerPath }))

  return app
}

export interface ServerInfo {
  server: ServerType
  port: number
  url: string
}

export function startServer(port: number = 0): Promise<ServerInfo> {
  return new Promise((resolve, reject) => {
    try {
      const app = createApp()
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
