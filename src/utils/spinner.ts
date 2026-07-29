import type { Ora } from 'ora'

/** Options for {@link withSpin}. */
interface WithSpinOptions<T> {
  /** Spinner to drive. Shared across steps so they render on one line. */
  spinner: Ora
  /** Text shown while `fn` runs. */
  message: string
  /** The work to run. */
  fn: () => Promise<T>
  /** Success text, or a function of the result. Omit for a bare checkmark. */
  successMessage?: string | ((result: T) => string)
  /** Failure text, or a function of the error. Omit for a bare cross. */
  failMessage?: string | ((error: Error) => string)
}

/**
 * Runs `fn` with a spinner, marking it succeeded or failed when it settles.
 *
 * @returns Whatever `fn` resolves to.
 * @throws The original error, re-thrown unchanged after the spinner is marked
 *   failed — this reports progress, it does not handle errors. Note that a
 *   thrown non-Error is still passed to `failMessage` wrapped as an `Error`.
 */
export async function withSpin<T>(options: WithSpinOptions<T>): Promise<T> {
  const { spinner, message, fn, successMessage, failMessage } = options

  spinner.start(message)

  try {
    const result = await fn()

    if (successMessage) {
      const msg =
        typeof successMessage === 'function'
          ? successMessage(result)
          : successMessage
      spinner.succeed(msg)
    } else {
      spinner.succeed()
    }

    return result
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))

    if (failMessage) {
      const msg =
        typeof failMessage === 'function' ? failMessage(err) : failMessage
      spinner.fail(msg)
    } else {
      spinner.fail()
    }

    throw error
  }
}
