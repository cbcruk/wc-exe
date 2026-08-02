import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CACHE_ROOT } from '../core/cache.js'

/** Where a running daemon advertises itself. */
export const DISCOVERY_PATH = path.join(CACHE_ROOT, 'daemon.json')

/** Contents of {@link DISCOVERY_PATH}. */
export interface DaemonRecord {
  /** Daemon process id, used to detect a stale record. */
  pid: number
  /** Port the daemon bound. */
  port: number
  /** Bearer token for the control plane. */
  token: string
  /** wc-exe version that started it; a mismatch means the runner bundle moved. */
  version: string
  /** ISO timestamp, for `daemon status`. */
  startedAt: string
}

/**
 * Generates a control-plane token.
 *
 * 256 bits from a CSPRNG: this is the only thing standing between any process
 * on the machine and a service that runs builds.
 */
export function createToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Writes the discovery record with `0600`.
 *
 * The mode is the point — the token inside grants control-plane access, so a
 * world-readable file would hand it to every account on the machine. Written to
 * a temp file and renamed so a reader never sees a half-written record, and
 * created with the mode already set rather than chmod-ed afterwards, which
 * would leave a window where it is readable.
 */
export function writeRecord(record: DaemonRecord): void {
  fs.mkdirSync(CACHE_ROOT, { recursive: true })

  const temporary = `${DISCOVERY_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, DISCOVERY_PATH)
}

/**
 * Reads the discovery record.
 *
 * @returns The record, or `null` if there is none or it is unreadable/corrupt.
 *   A corrupt record is treated as absent — the caller starts a fresh daemon,
 *   which is always recoverable.
 */
export function readRecord(): DaemonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8'))
    if (
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.port !== 'number' ||
      typeof parsed?.token !== 'string' ||
      typeof parsed?.version !== 'string'
    ) {
      return null
    }
    return parsed as DaemonRecord
  } catch {
    return null
  }
}

/** Removes the discovery record. Safe when it is already gone. */
export function clearRecord(): void {
  try {
    fs.unlinkSync(DISCOVERY_PATH)
  } catch {
    /* already gone */
  }
}

/**
 * Whether a process with this pid exists.
 *
 * Used to spot a record left behind by a daemon that crashed. Signal `0`
 * performs the permission and existence checks without delivering anything.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
