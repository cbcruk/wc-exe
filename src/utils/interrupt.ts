/**
 * Ctrl-C handling that actually exits.
 *
 * The obvious spelling is wrong, and all three commands had it:
 *
 * ```ts
 * process.on('SIGINT', async () => {
 *   await cleanup()
 *   process.exit(130)
 * })
 * ```
 *
 * An `EventEmitter` does not await its listener. It calls the function, gets a
 * promise back, and drops it. So a `cleanup` that rejects never reaches the
 * `process.exit` below it, and the rejection goes nowhere — Node's default for
 * an unhandled rejection is to print a warning that scrolls past under a
 * spinner, or to be swallowed entirely by the terminal state ora leaves behind.
 * What the user sees is Ctrl-C not working, with nothing saying why.
 *
 * This is the failure mode a `Result` type does not reach: there is no caller
 * here to hand a `Result` to. The promise is dropped by the listener contract
 * itself, so the fix has to be at the call site, not in the return type.
 */
export function onInterrupt(options: {
  /** Printed before cleanup starts. Already styled by the caller. */
  message: string
  cleanup: () => Promise<void>
  exitCode: number
}): void {
  process.on('SIGINT', () => {
    console.log(options.message)

    void options
      .cleanup()
      .catch((error: unknown) => {
        // Named rather than swallowed: cleanup failing is worth knowing about,
        // and it is the only chance to say so before the process goes.
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`  Cleanup after interrupt failed: ${reason}`)
      })
      .finally(() => process.exit(options.exitCode))
  })
}

/**
 * Reports async failures that no caller is waiting for.
 *
 * A typed error vocabulary only reaches failures that reach a caller. These are
 * the ones that do not: a promise nobody awaited, a rejection inside a callback
 * whose signature returns `void`, a `void`-marked call that turned out to
 * matter. `@typescript-eslint/no-floating-promises` catches most of them at
 * build time; this catches whatever is left at runtime, so it is reported
 * rather than silently changing what the process does.
 *
 * Node's default for an unhandled rejection is to terminate, which is right for
 * a one-shot CLI and wrong for a daemon holding other people's sessions — hence
 * `exitOnRejection`.
 *
 * The runner page has had the equivalent since it started driving itself
 * (`window.addEventListener('unhandledrejection', …)` in `runner/src/main.ts`).
 * The Node half never did.
 */
export function reportUnhandled(options: {
  /** Prefix identifying which process is speaking, e.g. `wc-exe`. */
  label: string
  /** Exit non-zero on an unhandled rejection. Off for long-lived processes. */
  exitOnRejection: boolean
}): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const detail = reason instanceof Error ? reason.stack : String(reason)
    console.error(`\n[${options.label}] Unhandled rejection: ${detail}`)
    if (options.exitOnRejection) process.exit(3)
  })

  process.on('uncaughtException', (error: Error) => {
    console.error(`\n[${options.label}] Uncaught exception: ${error.stack}`)
    process.exit(3)
  })
}
