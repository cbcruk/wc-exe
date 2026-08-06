/**
 * Entry point for the detached daemon process.
 *
 * Separate from `daemon.ts` so the CLI can import the daemon's types and
 * `startDaemon` without any risk of starting one as an import side effect.
 */
import { startDaemon } from './daemon.js'

const idleMs = process.env.WC_EXE_DAEMON_IDLE_MS
  ? Number(process.env.WC_EXE_DAEMON_IDLE_MS)
  : undefined

startDaemon({
  idleMs,
  verbose: process.env.WC_EXE_DAEMON_VERBOSE === '1',
}).catch((error) => {
  console.error('Daemon failed to start:', (error as Error).message)
  process.exit(1)
})
