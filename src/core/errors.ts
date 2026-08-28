/**
 * The error vocabulary — what can go wrong, as types rather than strings.
 *
 * Every failure in this project used to be `throw new Error(message)`, and the
 * message was the only thing that survived. That is workable inside one
 * function and falls apart across a boundary: the runner posts a failure to the
 * host over HTTP, the daemon posts one to the CLI over HTTP again, and at each
 * hop everything the thrower knew — which step, which exit code, whether the
 * runtime was left half-written — collapsed into one line of prose. Callers
 * that needed to *decide* something then had nothing to decide on.
 *
 * There was a bug in exactly that shape. `Session.build` poisoned a session on
 * every failure, because a bare `Error` gave it no way to tell "the user's
 * TypeScript does not compile" (runtime is fine, reuse it) from "the upload
 * died half way" (runtime is unknown, throw it away). The common case —
 * iterating on a build that does not compile yet — tore down the container
 * every run and made `--daemon` slower than not using it.
 *
 * So the test for adding a tag here is not "is this a distinct failure". It is
 * **does some caller branch on it**. {@link runtimeStateIsKnown} and
 * {@link exitCodeFor} below are those branches; a tag that appears in neither,
 * and in no `match` elsewhere, is a string with extra steps.
 */

import { TaggedError, isTaggedError } from 'better-result'
import type { CommandResult } from './types.js'

// Matches CSI escape sequences. Built from a char code because a literal 0x1b
// is an invisible byte that tooling can silently eat.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g')

/** How many trailing lines of output to quote in an error message. */
const TAIL_LINES = 20

// ---------------------------------------------------------------------------
// The runtime is fine — these say the *project* failed, not the container
// ---------------------------------------------------------------------------

/**
 * A command inside the runtime exited non-zero.
 *
 * The output tail travels as a field rather than only inside `message`, because
 * the host is not the last reader: the daemon has to put it on the wire again,
 * and a caller that wants the exit code should not have to parse English.
 */
export class CommandFailed extends TaggedError('CommandFailed')<{
  /** Human-readable command name, e.g. `npm run build`. */
  label: string
  exitCode: number
  /** Captured output, ANSI escapes intact. Possibly only the tail. */
  output: string
  truncated: boolean
  droppedChars: number
  message: string
}> {}

/**
 * The build reported success and produced nothing.
 *
 * Its own tag rather than a `CommandFailed` with a made-up exit code: a tool
 * that cannot spawn its own binary still exits 0, so "succeeded" and "produced
 * something" are genuinely different claims and the fix is a different one.
 */
export class NoBuildOutput extends TaggedError('NoBuildOutput')<{
  distPath: string
  message: string
}> {}

/**
 * The page holding the runtime went away — tab closed, navigated, reloaded.
 *
 * Not a poisoning failure: the container went with the tab, so there is no
 * half-written state to inherit. `Session` already resets itself from
 * `link.onDisconnect`, and the next build simply opens a fresh page.
 */
export class RunnerGone extends TaggedError('RunnerGone')<{
  reason: string
  message: string
}> {}

// ---------------------------------------------------------------------------
// The runtime is in an unknown state — do not reuse it
// ---------------------------------------------------------------------------

/**
 * A command was killed for running past its timeout.
 *
 * Deliberately **not** grouped with {@link CommandFailed}. A command that
 * exited told us it was done; one that was killed was interrupted at an
 * arbitrary point and may have left a partial `node_modules` or a half-written
 * `dist` behind. That difference is the whole reason this tag exists.
 */
export class RunnerTimeout extends TaggedError('RunnerTimeout')<{
  label: string
  timeoutMs: number
  message: string
}> {}

/** Pushing project files into the runtime failed part-way. */
export class MountFailed extends TaggedError('MountFailed')<{
  path: string
  message: string
}> {}

/** Copying an artifact back to the host failed part-way. */
export class UploadFailed extends TaggedError('UploadFailed')<{
  path: string
  /** HTTP status the host answered with, when there was one. */
  status?: number
  message: string
}> {}

/** Anything else the runner failed at, named by the operation it was doing. */
export class RuntimeFailure extends TaggedError('RuntimeFailure')<{
  operation: string
  message: string
}> {}

/**
 * A failure that arrived without a tag this build understands.
 *
 * The host and the runner are separate bundles and can be out of step — an
 * upgraded CLI driving a page served from a stale cache, say. Rather than
 * guess, unknown failures land here, and {@link runtimeStateIsKnown} treats
 * them as unsafe. Guessing wrong in the other direction means reusing a
 * container we cannot characterise, which is the failure that looks like
 * success.
 */
export class UnknownFailure extends TaggedError('UnknownFailure')<{
  /** The tag that came over the wire, when there was one. */
  originalTag?: string
  message: string
}> {}

// ---------------------------------------------------------------------------
// Host-side: nothing to do with the runtime's contents
// ---------------------------------------------------------------------------

/** The path the caller asked to build is not a directory we can build. */
export class InvalidProject extends TaggedError('InvalidProject')<{
  source: string
  reason: string
  message: string
}> {}

/** The runner page never reported ready at the URL it was served from. */
export class RunnerUnavailable extends TaggedError('RunnerUnavailable')<{
  url: string
  message: string
}> {}

/** A daemon is advertised but does not answer. */
export class DaemonUnreachable extends TaggedError('DaemonUnreachable')<{
  port: number
  message: string
}> {}

/** A freshly spawned daemon never advertised itself. */
export class DaemonStartTimeout extends TaggedError('DaemonStartTimeout')<{
  timeoutMs: number
  message: string
}> {}

/** Every failure this project names. */
export type WcError =
  | CommandFailed
  | NoBuildOutput
  | RunnerGone
  | RunnerTimeout
  | MountFailed
  | UploadFailed
  | RuntimeFailure
  | UnknownFailure
  | InvalidProject
  | RunnerUnavailable
  | DaemonUnreachable
  | DaemonStartTimeout

// ---------------------------------------------------------------------------
// The decisions these tags exist for
// ---------------------------------------------------------------------------

/**
 * Tags after which the runtime's contents are still exactly what we believe.
 *
 * An allowlist, not a blocklist, and that direction is the point: a tag added
 * later is unsafe until someone says otherwise. The opposite default fails
 * silently — a new failure mode would be reused into the next build, and the
 * symptom is a wrong artifact rather than an error.
 */
const RUNTIME_STATE_KNOWN = new Set<string>([
  'CommandFailed',
  'NoBuildOutput',
  'RunnerGone',
])

/**
 * Whether a session may be reused after this failure.
 *
 * Anything that is not one of ours — a `TypeError` from a bug in this code, say
 * — answers `false`, for the same reason {@link UnknownFailure} does.
 */
export function runtimeStateIsKnown(error: unknown): boolean {
  return isWcError(error) && RUNTIME_STATE_KNOWN.has(error._tag)
}

/**
 * Process exit code for a failure.
 *
 * Three meanings, so a script can tell them apart without reading stderr:
 * `1` the project did not build, `2` the invocation was wrong, `3` wc-exe's own
 * machinery failed. Today every path exits `1`, which makes "your code is
 * broken" and "the daemon would not start" indistinguishable in CI.
 */
export function exitCodeFor(error: unknown): 1 | 2 | 3 {
  if (!isWcError(error)) return 3
  switch (error._tag) {
    case 'CommandFailed':
    case 'NoBuildOutput':
      return 1
    case 'InvalidProject':
      return 2
    default:
      return 3
  }
}

/** Whether a value is one of the errors named above. */
export function isWcError(error: unknown): error is WcError {
  return isTaggedError(error) && TAGS.has(error._tag)
}

const TAGS = new Set<string>([
  'CommandFailed',
  'NoBuildOutput',
  'RunnerGone',
  'RunnerTimeout',
  'MountFailed',
  'UploadFailed',
  'RuntimeFailure',
  'UnknownFailure',
  'InvalidProject',
  'RunnerUnavailable',
  'DaemonUnreachable',
  'DaemonStartTimeout',
])

// ---------------------------------------------------------------------------
// Crossing a transport
// ---------------------------------------------------------------------------

/** A {@link WcError} flattened for JSON. */
export interface WireError {
  _tag: string
  message: string
  [field: string]: unknown
}

/**
 * Flattens an error for a transport.
 *
 * `stack` is dropped rather than forwarded. A stack from the runner names lines
 * in a minified page bundle, which tells the host's reader nothing, and it is
 * by far the largest field — the daemon puts this in every failing build
 * response.
 */
export function toWire(error: unknown): WireError {
  if (isWcError(error)) {
    const {
      stack: _stack,
      name: _name,
      cause: _cause,
      ...rest
    } = error.toJSON() as Record<string, unknown>
    return { ...rest, _tag: error._tag, message: error.message }
  }

  const message = error instanceof Error ? error.message : String(error)
  return { _tag: 'UnknownFailure', message }
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * Rebuilds an error from a transport.
 *
 * An explicit switch rather than a constructor lookup, because this parses
 * input from another process: a table keyed on the incoming tag would happily
 * build a half-populated error out of a malformed payload, and the missing
 * field would surface much later as `undefined` in a message. Anything that
 * does not match lands on {@link UnknownFailure} with its original tag kept,
 * so a host/runner version skew is visible instead of merely confusing.
 */
export function fromWire(payload: unknown): WcError {
  if (typeof payload !== 'object' || payload === null) {
    return new UnknownFailure({ message: String(payload) })
  }

  const wire = payload as Record<string, unknown>
  const tag = asString(wire._tag)
  const message = asString(wire.message, 'Runner call failed')

  switch (tag) {
    case 'CommandFailed':
      return new CommandFailed({
        label: asString(wire.label, 'command'),
        exitCode: asNumber(wire.exitCode, 1),
        output: asString(wire.output),
        truncated: wire.truncated === true,
        droppedChars: asNumber(wire.droppedChars, 0),
        message,
      })
    case 'NoBuildOutput':
      return new NoBuildOutput({ distPath: asString(wire.distPath), message })
    case 'RunnerGone':
      return new RunnerGone({ reason: asString(wire.reason), message })
    case 'RunnerTimeout':
      return new RunnerTimeout({
        label: asString(wire.label, 'command'),
        timeoutMs: asNumber(wire.timeoutMs, 0),
        message,
      })
    case 'MountFailed':
      return new MountFailed({ path: asString(wire.path), message })
    case 'UploadFailed':
      return new UploadFailed({
        path: asString(wire.path),
        status: typeof wire.status === 'number' ? wire.status : undefined,
        message,
      })
    case 'RuntimeFailure':
      return new RuntimeFailure({
        operation: asString(wire.operation, 'unknown'),
        message,
      })
    case 'InvalidProject':
      return new InvalidProject({
        source: asString(wire.source),
        reason: asString(wire.reason),
        message,
      })
    case 'RunnerUnavailable':
      return new RunnerUnavailable({ url: asString(wire.url), message })
    case 'DaemonUnreachable':
      return new DaemonUnreachable({
        port: asNumber(wire.port, 0),
        message,
      })
    case 'DaemonStartTimeout':
      return new DaemonStartTimeout({
        timeoutMs: asNumber(wire.timeoutMs, 0),
        message,
      })
    case 'UnknownFailure':
      return new UnknownFailure({
        originalTag:
          typeof wire.originalTag === 'string' ? wire.originalTag : undefined,
        message,
      })
    default:
      return new UnknownFailure({
        originalTag: tag || undefined,
        message,
      })
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Extracts the useful tail of command output: ANSI stripped, blank lines
 * dropped, at most {@link TAIL_LINES} lines.
 */
export function outputTail(output: string, maxLines = TAIL_LINES): string {
  const lines = output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  return lines.slice(-maxLines).join('\n')
}

/**
 * Builds the error for a command that exited non-zero.
 *
 * Includes the output tail because the exit code alone is not actionable —
 * "npm run build failed with exit code 1" tells the user nothing they can fix.
 * Truncation is stated rather than hidden, so nobody reads a partial log as the
 * whole story.
 *
 * The composed sentence lives in `message`, and the parts it was composed from
 * stay as fields. Both readers are real: a terminal wants the sentence, and
 * {@link fromWire} on the far side of a transport wants to rebuild the same
 * sentence without re-deriving it from prose.
 *
 * @param label Human-readable command name, e.g. `npm run build`.
 */
export function commandFailure(
  label: string,
  result: CommandResult
): CommandFailed {
  const tail = outputTail(result.output)

  const parts = [`${label} failed with exit code ${result.exitCode}`]

  if (tail) {
    parts.push('', tail)
  }

  if (result.truncated) {
    parts.push(
      '',
      `(output truncated — ${result.droppedChars} earlier characters dropped)`
    )
  }

  return new CommandFailed({
    label,
    exitCode: result.exitCode,
    output: result.output,
    truncated: result.truncated,
    droppedChars: result.droppedChars,
    message: parts.join('\n'),
  })
}
