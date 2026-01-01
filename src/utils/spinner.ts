import type { Ora } from 'ora'

interface WithSpinOptions<T> {
  spinner: Ora
  message: string
  fn: () => Promise<T>
  successMessage?: string | ((result: T) => string)
  failMessage?: string | ((error: Error) => string)
}

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
