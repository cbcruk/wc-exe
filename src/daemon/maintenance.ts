/**
 * What the daemon should do next, computed from scratch every pass.
 *
 * The background work used to be two `if`s inside a `setInterval`: shut down if
 * nothing has arrived for a while, shut down if the discovery record stopped
 * pointing at us. That shape works right up until the list of things worth
 * fixing grows past what fits in a timer callback — and it had already stopped
 * covering the list. Nothing ever reclaimed a session, so a poisoned one sat
 * there holding a link until someone happened to build that same project again,
 * and `Session.lastUsedAt` carried the comment "for idle eviction" while nothing
 * evicted anything.
 *
 * The fix is not another `if`. It is to stop treating maintenance as a reaction
 * to events and make it a **convergence pass**: every tick, describe the state
 * the daemon should be in, compare it to the state it is in, and do one bounded
 * unit of the most important missing work. An event-driven cleanup that misses
 * its event leaves a hole forever; a pass that recomputes has nothing to miss —
 * whatever it failed to finish is still undone next time, and gets picked up.
 *
 * Two properties follow, and both are the point:
 *
 * - **It is a pure function of its inputs.** {@link nextMaintenanceAction} reads
 *   no clock, no disk and no sockets, so what the daemon decides can be tested
 *   without waiting for a timer or arranging a filesystem.
 * - **One action per pass.** A pass cannot stall on a queue of closes, and the
 *   next pass sees the state that actually resulted rather than the state it
 *   predicted — so a session that got busy in between is simply not closed.
 *
 * @module
 */

/** One bounded unit of work, or nothing to do. */
export type MaintenanceAction =
  | { kind: 'stop'; reason: string }
  | { kind: 'closeSession'; id: string; reason: string }
  | { kind: 'wait' }

/** A session, as far as maintenance is concerned. */
export interface SessionFacts {
  id: string
  /** Epoch ms of the last build. */
  lastUsedAt: number
  /** Why it cannot be reused, or `null`. */
  poisoned: string | null
  /** Whether a page currently holds its control channel open. */
  connected: boolean
}

/** Everything the decision depends on. Nothing here is read; it is passed in. */
export interface MaintenanceState {
  now: number
  /** Epoch ms the control plane was last touched. */
  lastActivity: number
  /** How long with no control-plane traffic before the daemon exits. */
  idleMs: number
  pid: number
  /**
   * The discovery record as it is on disk, or `null` when it is absent or
   * unreadable — `readRecord` cannot tell those apart, and does not need to.
   */
  record: { pid: number } | null
  sessions: SessionFacts[]
}

/**
 * The most important missing work, or `wait`.
 *
 * The order below is the priority order, and it is deliberate: reasons to stop
 * come before reasons to tidy, because tidying a daemon that is about to exit
 * is wasted, and a daemon nothing can reach should not linger doing chores.
 */
export function nextMaintenanceAction(
  state: MaintenanceState
): MaintenanceAction {
  // 1. Nobody can manage us any more.
  //
  // Left running, this daemon keeps the port while every CLI reports that no
  // daemon exists — `docs/persistent-runner.md` §13.3, found when an
  // integration test wiped the cache directory and orphaned the process.
  //
  // Deliberately *not* self-healed by rewriting the record. Rebuilding a
  // missing artefact is the right default for work this daemon owns, and the
  // record is not that: it is the one file that says which process owns the
  // advertisement, so a daemon that rewrites it whenever it goes missing can
  // take an advertisement back from another one. Exiting is recoverable — the
  // next CLI starts a fresh daemon — and that asymmetry decides it.
  if (!state.record) {
    return { kind: 'stop', reason: 'the discovery record is gone' }
  }
  if (state.record.pid !== state.pid) {
    return {
      kind: 'stop',
      reason: `the discovery record points at pid ${state.record.pid}`,
    }
  }

  // 2. Nobody is using us.
  if (state.now - state.lastActivity > state.idleMs) {
    return {
      kind: 'stop',
      reason: `idle for ${Math.round((state.now - state.lastActivity) / 1000)}s`,
    }
  }

  // 3. A session that can never serve another build.
  //
  // The daemon already replaces a poisoned session when a build arrives for
  // that project. What it never did is reclaim one for a project nobody builds
  // again, which is the common case after a failure — you fix something else,
  // or stop for the day. It holds a link and a page the daemon cannot use.
  const poisoned = state.sessions.find((session) => session.poisoned !== null)
  if (poisoned) {
    return {
      kind: 'closeSession',
      id: poisoned.id,
      reason: `unusable: ${poisoned.poisoned}`,
    }
  }

  // 4. A session whose page is gone and which nobody came back to.
  //
  // Both conditions, not either. An idle session whose tab is still open is
  // left alone on purpose: closing it would turn a page someone still has open
  // into one that 404s against a session id that no longer exists, and the
  // daemon cannot close the tab to explain why. A session with no page is
  // already holding nothing but memory.
  const abandoned = state.sessions.find(
    (session) =>
      !session.connected && state.now - session.lastUsedAt > state.idleMs
  )
  if (abandoned) {
    return {
      kind: 'closeSession',
      id: abandoned.id,
      reason: 'its page is gone and it has been idle',
    }
  }

  return { kind: 'wait' }
}
