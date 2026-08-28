import { exitCodeFor } from '../core/errors.js'

/**
 * The message to show for anything throwable.
 *
 * `(error as Error).message` is a lie whenever the thrown thing was not an
 * Error — it yields `undefined`, printed as the word "undefined" where the
 * cause should be.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reports a failure and ends the process with a code that says what kind it was.
 *
 * Every command used to exit `1`, so "your project does not compile" and "the
 * daemon would not start" were the same event to anything reading the exit
 * status. In CI that is the difference between a red build someone should look
 * at and an infrastructure blip that should be retried, and it was not
 * available.
 *
 * The three codes are {@link exitCodeFor}'s: `1` the project did not build,
 * `2` the invocation was wrong, `3` wc-exe could not do its job. Nothing extra
 * is printed to explain which one happened — the messages already say, and a
 * banner announcing the category would be noise above a build log.
 */
export function reportFailure(label: string, error: unknown): never {
  console.error(`\n${label}:`, errorMessage(error))
  process.exit(exitCodeFor(error))
}
