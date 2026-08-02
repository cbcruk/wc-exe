import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readRecord,
  clearRecord,
  isProcessAlive,
  type DaemonRecord,
} from './discovery.js'
import { VERSION } from '../version.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** How long to wait for a freshly spawned daemon to advertise itself. */
const START_TIMEOUT_MS = 20_000

/** Health payload returned by `GET /control/health`. */
export interface DaemonHealth {
  version: string
  pid: number
  uptimeMs: number
  idleMs: number
  sessions: Array<{
    id: string
    source: string
    lastUsedAt: string
    poisoned: string | null
  }>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calls the control plane.
 *
 * Sends no `Origin` header, which the daemon requires — see `controlPlaneGuard`.
 */
async function call<T>(
  record: DaemonRecord,
  route: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${record.port}${route}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: `Bearer ${record.token}`,
      'content-type': 'application/json',
    },
  })

  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string
    logs?: string[]
  }
  if (!response.ok) {
    // Carry the daemon's progress log into the error. Without it a failure
    // arrives as a bare message with no indication of which step produced it,
    // which is exactly the hole `commandFailure` was added to close on the
    // one-shot path.
    const error = new Error(
      body.error ?? `Daemon returned ${response.status}`
    ) as Error & { logs?: string[] }
    error.logs = body.logs
    throw error
  }
  return body
}

/** Asks a daemon for its health, or `null` if it is not answering. */
export async function probe(
  record: DaemonRecord
): Promise<DaemonHealth | null> {
  try {
    return await call<DaemonHealth>(record, '/control/health')
  } catch {
    return null
  }
}

/** Stops a running daemon. Returns whether one was there to stop. */
export async function stopDaemon(): Promise<boolean> {
  const record = readRecord()
  if (!record) return false

  try {
    await call(record, '/control/stop', { method: 'POST' })
    return true
  } catch {
    // Unreachable but recorded: clean up so the next run does not trip on it.
    clearRecord()
    return false
  }
}

/** Reports on the running daemon, if any. */
export async function daemonStatus(): Promise<{
  record: DaemonRecord
  health: DaemonHealth
} | null> {
  const record = readRecord()
  if (!record) return null

  const health = await probe(record)
  if (!health) return null

  return { record, health }
}

/**
 * Locates the built daemon entry point.
 *
 * The bundler emits it beside the CLI, but this module ends up in a shared
 * chunk whose depth is a build detail — so the candidates are checked rather
 * than assumed, and a wrong guess fails loudly here instead of as a daemon that
 * mysteriously never comes up.
 */
function resolveDaemonEntry(): string {
  const candidates = [
    path.resolve(__dirname, 'daemon/daemon-entry.js'),
    path.resolve(__dirname, 'daemon-entry.js'),
    path.resolve(__dirname, '../daemon/daemon-entry.js'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Could not find the daemon entry point. Looked in:\n  ${candidates.join('\n  ')}`
  )
}

/** Spawns a detached daemon and waits for it to advertise itself. */
async function spawnDaemon(verbose: boolean): Promise<DaemonRecord> {
  const entry = resolveDaemonEntry()

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: verbose ? 'inherit' : 'ignore',
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const record = readRecord()
    if (record && record.pid !== process.pid) {
      const health = await probe(record)
      if (health) return record
    }
    await sleep(150)
  }

  throw new Error(
    `The daemon did not come up within ${START_TIMEOUT_MS / 1000}s. ` +
      `Try 'wc-exe daemon stop' and run again, or omit --daemon.`
  )
}

/**
 * Returns a healthy daemon, starting one if needed.
 *
 * Replaces a daemon that is stale in any of the ways that matter:
 *
 * - **Dead process.** A record left by a crash would otherwise be dialled
 *   forever.
 * - **Not answering.** Alive but wedged is no more useful than gone.
 * - **Version mismatch.** The daemon holds a *booted* copy of the runner
 *   bundle. After an upgrade it would keep serving the old one, so builds would
 *   silently run on superseded code — the kind of failure that looks like
 *   success until someone notices the output is wrong.
 */
export async function ensureDaemon(
  options: { verbose?: boolean } = {}
): Promise<DaemonRecord> {
  const record = readRecord()

  if (record) {
    if (!isProcessAlive(record.pid)) {
      clearRecord()
    } else {
      const health = await probe(record)
      if (!health) {
        clearRecord()
      } else if (health.version !== VERSION) {
        await stopDaemon()
        clearRecord()
      } else {
        return record
      }
    }
  }

  return await spawnDaemon(options.verbose ?? false)
}

/** Result of a daemon-run build. */
export interface DaemonBuildResult {
  ok: boolean
  logs: string[]
  reused: boolean
  upserted: number
  removed: number
  written: number
}

/** Runs a build on the daemon. */
export async function buildViaDaemon(
  record: DaemonRecord,
  body: {
    source: string
    output: string
    distDir: string
    noInstall: boolean
    fresh: boolean
    timeout?: number
  }
): Promise<DaemonBuildResult> {
  return await call<DaemonBuildResult>(record, '/control/build', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
