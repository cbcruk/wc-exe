import { describe, expect, it } from 'vitest'
import {
  nextMaintenanceAction,
  type MaintenanceState,
  type SessionFacts,
} from './maintenance.js'

/**
 * The decision, tested without a daemon, a timer or a filesystem.
 *
 * That is the reason it is a pure function: the previous shape put the same
 * logic inside a `setInterval` callback, where reaching it meant starting a
 * daemon and waiting thirty seconds, so in practice nothing tested it at all.
 */

const MINUTE = 60_000

function session(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id: 'a',
    lastUsedAt: 1_000_000,
    poisoned: null,
    connected: true,
    ...overrides,
  }
}

function state(overrides: Partial<MaintenanceState> = {}): MaintenanceState {
  return {
    now: 1_000_000,
    lastActivity: 1_000_000,
    idleMs: 10 * MINUTE,
    pid: 42,
    record: { pid: 42 },
    sessions: [],
    ...overrides,
  }
}

describe('a daemon nobody can manage', () => {
  it('stops when its discovery record is gone', () => {
    expect(nextMaintenanceAction(state({ record: null }))).toMatchObject({
      kind: 'stop',
    })
  })

  it('stops when the record points at another process', () => {
    const action = nextMaintenanceAction(state({ record: { pid: 99 } }))

    expect(action).toMatchObject({ kind: 'stop' })
    expect(action).toMatchObject({ reason: expect.stringContaining('99') })
  })

  it('does not stop while the record still points at it', () => {
    expect(nextMaintenanceAction(state())).toEqual({ kind: 'wait' })
  })
})

describe('an idle daemon', () => {
  it('stops once nothing has arrived for longer than its window', () => {
    const action = nextMaintenanceAction(
      state({ now: 1_000_000 + 11 * MINUTE, lastActivity: 1_000_000 })
    )

    expect(action).toMatchObject({ kind: 'stop' })
  })

  it('keeps waiting inside the window', () => {
    expect(
      nextMaintenanceAction(
        state({ now: 1_000_000 + 9 * MINUTE, lastActivity: 1_000_000 })
      )
    ).toEqual({ kind: 'wait' })
  })
})

describe('reclaiming sessions', () => {
  it('closes a poisoned session, which nothing used to do', () => {
    const action = nextMaintenanceAction(
      state({
        sessions: [session({ id: 'bad', poisoned: 'RunnerTimeout: …' })],
      })
    )

    expect(action).toEqual({
      kind: 'closeSession',
      id: 'bad',
      reason: 'unusable: RunnerTimeout: …',
    })
  })

  it('closes an idle session whose page is gone', () => {
    const action = nextMaintenanceAction(
      state({
        now: 1_000_000 + 11 * MINUTE,
        lastActivity: 1_000_000 + 11 * MINUTE,
        sessions: [session({ id: 'old', connected: false })],
      })
    )

    expect(action).toMatchObject({ kind: 'closeSession', id: 'old' })
  })

  it('leaves an idle session alone while its tab is still open', () => {
    // Closing it would turn a page someone still has open into one that 404s,
    // and the daemon cannot close the tab to say why.
    expect(
      nextMaintenanceAction(
        state({
          now: 1_000_000 + 11 * MINUTE,
          lastActivity: 1_000_000 + 11 * MINUTE,
          sessions: [session({ connected: true })],
        })
      )
    ).toEqual({ kind: 'wait' })
  })

  it('leaves a disconnected session alone until it has also gone idle', () => {
    // A page reloading is a disconnect too. Reclaiming on that alone would take
    // the session out from under a build someone is still running.
    expect(
      nextMaintenanceAction(
        state({ sessions: [session({ connected: false })] })
      )
    ).toEqual({ kind: 'wait' })
  })
})

describe('what a pass does when several things are wrong', () => {
  it('stops rather than tidying a daemon that is about to exit', () => {
    const action = nextMaintenanceAction(
      state({
        record: null,
        sessions: [session({ poisoned: 'MountFailed: …' })],
      })
    )

    expect(action).toMatchObject({ kind: 'stop' })
  })

  it('returns one action, leaving the rest to the next pass', () => {
    // Bounded on purpose: a pass cannot stall on a queue of closes, and the
    // next one recomputes from the state that actually resulted.
    const action = nextMaintenanceAction(
      state({
        sessions: [
          session({ id: 'one', poisoned: 'x' }),
          session({ id: 'two', poisoned: 'y' }),
        ],
      })
    )

    expect(action).toMatchObject({ kind: 'closeSession', id: 'one' })
  })

  it('picks up what the last pass did not finish', () => {
    // Self-healing by construction: whatever remains undone is simply still
    // missing next time. Nothing has to remember that a close failed.
    const remaining = state({
      sessions: [session({ id: 'two', poisoned: 'y' })],
    })

    expect(nextMaintenanceAction(remaining)).toMatchObject({
      kind: 'closeSession',
      id: 'two',
    })
  })
})
