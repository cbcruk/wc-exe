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
import {
  DaemonStartTimeout,
  DaemonUnreachable,
  RuntimeFailure,
  fromWire,
  type WcError,
  type WireError,
} from '../core/errors.js'

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
/**
 * What every control-plane failure response carries.
 *
 * No `ok` field: intersecting it with a success body whose `ok` is `true` would
 * collapse the property to `never` and take the rest of the shape with it.
 * Success is read from the HTTP status and the body's own `ok`.
 */
interface ControlFailure {
  /** Progress the daemon recorded before it failed. */
  logs: string[]
  error: WireError
}

/**
 * Sends one control-plane request and hands back whatever came with it.
 *
 * Separate from {@link call} because a *failed build* is not a failed request:
 * the response body carries the daemon's progress log, and the CLI needs to
 * print it. Throwing here would leave the caller holding an error and no log —
 * which is how the log used to end up smuggled onto the `Error` object as an
 * undeclared `logs` property, a contract living entirely outside the types.
 */
async function request<T>(
  record: DaemonRecord,
  route: string,
  init?: RequestInit
): Promise<{ ok: boolean; body: Partial<T & ControlFailure> }> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${record.port}${route}`, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
    })
  } catch (cause) {
    // A record pointing at nothing. Named rather than surfaced as fetch's
    // `TypeError: fetch failed`, which says nothing about what to do.
    throw new DaemonUnreachable({
      port: record.port,
      message:
        `The daemon on port ${record.port} did not answer: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    })
  }

  const body = (await response.json().catch(() => ({}))) as Partial<
    T & ControlFailure
  >
  return { ok: response.ok, body }
}

/** Reads the daemon's answer, or throws whatever it reported. */
async function call<T>(
  record: DaemonRecord,
  route: string,
  init?: RequestInit
): Promise<T> {
  const { ok, body } = await request<T>(record, route, init)
  if (!ok) throw failureOf(body, record)
  return body as T
}

/** Rebuilds the failure the daemon reported, tag and fields intact. */
function failureOf(
  body: Partial<ControlFailure>,
  record: DaemonRecord
): WcError {
  return fromWire(
    body.error ?? `The daemon on port ${record.port} failed without saying why`
  )
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

  throw new RuntimeFailure({
    operation: 'resolveDaemonEntry',
    message: `Could not find the daemon entry point. Looked in:\n  ${candidates.join('\n  ')}`,
  })
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

  throw new DaemonStartTimeout({
    timeoutMs: START_TIMEOUT_MS,
    message:
      `The daemon did not come up within ${START_TIMEOUT_MS / 1000}s. ` +
      `Try 'wc-exe daemon stop' and run again, or omit --daemon.`,
  })
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

/** A build the daemon completed. */
export interface DaemonBuildResult {
  ok: true
  logs: string[]
  reused: boolean
  upserted: number
  removed: number
  written: number
}

/**
 * What a daemon build came back as.
 *
 * A union rather than "return or throw", because **both outcomes carry the
 * log**. The daemon reports its progress line by line as it builds, and that
 * log is most useful on the run that failed — it is the only thing saying which
 * step the failure came from. An exception can only carry a value by having one
 * attached to it, which is what the old code did and why `logs` lived outside
 * the type system.
 *
 * Not a `Result` for the same reason: `Result<T, E>` carries a value on one
 * side or an error on the other, and this needs the log on both.
 */
export type DaemonBuildOutcome =
  | DaemonBuildResult
  | { ok: false; logs: string[]; error: WcError }

/**
 * Runs a build on the daemon.
 *
 * @returns The outcome, including a failed build — see
 *   {@link DaemonBuildOutcome}.
 * @throws If the daemon itself could not be reached or did not answer with a
 *   build outcome at all. That is a different failure from a build that ran and
 *   did not succeed, and the caller treats it differently.
 */
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
): Promise<DaemonBuildOutcome> {
  const { ok, body: result } = await request<DaemonBuildResult>(
    record,
    '/control/build',
    { method: 'POST', body: JSON.stringify(body) }
  )

  if (ok && result.ok) return result as DaemonBuildResult

  return {
    ok: false,
    logs: result.logs ?? [],
    error: failureOf(result, record),
  }
}
