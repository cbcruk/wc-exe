/**
 * The page's half of the error contract.
 *
 * `src/core/errors.ts` is the host's half, and this is deliberately **not** an
 * import of it. The two are built as separate bundles and cannot share code —
 * the same reason `core/types.ts` restates the runner's result shapes. What
 * they share is the wire format below, which is why that format is a plain
 * object rather than anything a library has to reconstruct.
 *
 * The host holds the tag list, `fromWire`, and the decisions the tags feed
 * (`runtimeStateIsKnown`, `exitCodeFor`). This side only has to *name* what
 * went wrong. So there is no dependency here and the page bundle does not grow:
 * a tag is a string and the fields are whatever the failure knew.
 *
 * A tag the host does not recognise is not a crash — it becomes an
 * `UnknownFailure` there, keeping the tag it arrived with, which is how a
 * host/runner version skew shows up as itself rather than as confusion.
 */

/** A failure flattened for the control channel. Mirrors `core/errors.ts`. */
export interface WireError {
  _tag: string
  message: string
  [field: string]: unknown
}

/**
 * An error carrying the tag and fields the host will rebuild it from.
 *
 * `message` stays a real `Error` message so the page console and the page's own
 * `unhandledrejection` reporter read normally; the fields ride alongside.
 */
export class RunnerError extends Error {
  readonly _tag: string
  readonly fields: Readonly<Record<string, unknown>>

  constructor(
    tag: string,
    message: string,
    fields: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = tag
    this._tag = tag
    this.fields = fields
  }
}

/** Fetching or writing the project into the runtime failed part-way. */
export const mountFailed = (path: string, message: string): RunnerError =>
  new RunnerError('MountFailed', message, { path })

/**
 * A command inside the runtime exited non-zero.
 *
 * The output travels with it. It used to be dropped here — `installWithCache`
 * threw `${manager} install failed with exit code ${exitCode}` and nothing
 * else, so a cached install that failed gave the user an exit code and no log,
 * while the same failure on the uncached path came with twenty lines of it.
 *
 * The sentence is not composed here. The host composes it in `commandFailure`
 * from these fields, so the wording lives in one place instead of in two
 * bundles that would drift apart the first time either changed.
 */
export const commandFailed = (
  label: string,
  result: {
    exitCode: number
    output: string
    truncated: boolean
    droppedChars: number
  }
): RunnerError =>
  new RunnerError(
    'CommandFailed',
    `${label} failed with exit code ${result.exitCode}`,
    { label, ...result }
  )

/** The build reported success and left nothing behind. */
export const noBuildOutput = (distPath: string, message: string): RunnerError =>
  new RunnerError('NoBuildOutput', message, { distPath })

/** An artifact could not be handed back to the host. */
export const uploadFailed = (
  path: string,
  status: number,
  message: string
): RunnerError => new RunnerError('UploadFailed', message, { path, status })

/** Anything else, named by the operation that was running. */
export const runtimeFailure = (
  operation: string,
  message: string
): RunnerError => new RunnerError('RuntimeFailure', message, { operation })

/**
 * Flattens anything throwable for the control channel.
 *
 * An untagged error still crosses — as `UnknownFailure` carrying its message.
 * Bugs in this bundle are exactly that: unexpected, and not something the host
 * should be asked to reason about beyond "do not reuse this runtime".
 */
export function toWire(error: unknown): WireError {
  if (error instanceof RunnerError) {
    return { ...error.fields, _tag: error._tag, message: error.message }
  }

  return {
    _tag: 'UnknownFailure',
    message: error instanceof Error ? error.message : String(error),
  }
}
