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
  // Escape hatch for a daemon that must not open tabs — a test harness, or a
  // machine with no desktop session to open them into. It then logs each
  // session's URL and waits for something else to produce the page.
  open: process.env.WC_EXE_DAEMON_NO_OPEN !== '1',
}).catch((error) => {
  console.error('Daemon failed to start:', (error as Error).message)
  process.exit(1)
})
