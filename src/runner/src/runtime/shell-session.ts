import type { Runtime, RuntimeProcess, TerminalSize } from './runtime.types'

/**
 * Signature jsh prints when its own job bookkeeping falls over.
 *
 * This is the **early warning**, not the proof. It fires the instant the shell
 * breaks, before anyone tries to cancel anything — but it depends on jsh's
 * exact wording, so a message change would silently disable it. The
 * authoritative checks below are functional and do not read this string.
 *
 * See docs/persistent-runner.md §2.3.
 */
const JSH_INTERNAL_ERROR = /jsh: Cannot read properties of undefined/

/** How long a single command may run before {@link ShellSession.exec} gives up. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long an interrupt has to visibly take effect before job control is
 * considered dead. Measured at well under a second on a healthy shell.
 */
const INTERRUPT_GRACE_MS = 5000

/** Bound on {@link ShellSession.verifyJobControl}. */
const VERIFY_TIMEOUT_MS = 20000

/**
 * A command that runs until interrupted, used by
 * {@link ShellSession.verifyJobControl}. `node` is guaranteed present — the
 * runtime is a Node sandbox — and there is no `sleep` binary.
 */
const VERIFY_FOREGROUND = 'node -e "setInterval(() => {}, 1000)"'

/** Result of one {@link ShellSession.exec}. */
export interface ShellExecResult {
  /** Everything the command printed, ANSI escapes intact. */
  output: string
  /** The command's exit status, or `null` if the shell did not report one. */
  exitCode: number | null
  /** Whether the command was cut short by {@link ShellSession.interrupt}. */
  interrupted: boolean
}

/** Options for {@link ShellSession.open}. */
export interface ShellSessionOptions {
  /** Shell to run. Defaults to `jsh`, the only shell WebContainer ships. */
  shell?: string
  /** Initial terminal size. */
  terminal?: TerminalSize
  /** Called with every output chunk as it arrives, for live streaming. */
  onData?: (chunk: string) => void
  /**
   * How long an interrupt has to visibly take effect before job control is
   * declared dead. Defaults to {@link INTERRUPT_GRACE_MS}.
   */
  interruptGraceMs?: number
}

/**
 * A long-lived interactive shell.
 *
 * **Writes are serialized by construction.** Every `exec` queues behind the
 * previous one, so a second command line can never be written before the first
 * has finished. That is not a nicety: writing early makes jsh throw an internal
 * error and silently lose job control, after which the shell still runs
 * commands and still prints output but Ctrl-C does nothing. Serializing at the
 * only place that writes is what makes that unrepresentable rather than merely
 * discouraged.
 *
 * Prefer plain `Runtime.spawn` for one-off commands — a fresh process per
 * command has no shared state to leak and none of this fragility. This exists
 * for interactive use, where the session *is* the point.
 */
export class ShellSession {
  private queue: Promise<unknown> = Promise.resolve()
  private transcript = ''
  private broken: string | null = null
  private closed = false
  private sequence = 0
  /** Counts interrupts, so a running exec can notice it was cut short. */
  private interrupts = 0

  private constructor(
    private readonly process: RuntimeProcess,
    private readonly onData?: (chunk: string) => void,
    private readonly interruptGraceMs: number = INTERRUPT_GRACE_MS
  ) {}

  /**
   * Starts a shell and waits for its first prompt.
   *
   * Takes only the part of {@link Runtime} it uses. Naming the whole interface
   * would overstate the dependency and force every unrelated change to it
   * through this file and its tests.
   */
  static async open(
    runtime: Pick<Runtime, 'spawn'>,
    options: ShellSessionOptions = {}
  ): Promise<ShellSession> {
    const process = await runtime.spawn(options.shell ?? 'jsh', [], {
      terminal: options.terminal ?? { cols: 80, rows: 24 },
    })

    const session = new ShellSession(
      process,
      options.onData,
      options.interruptGraceMs
    )
    session.consume()
    // Wait for the shell to print something — otherwise the first command is
    // written into a terminal that is not listening yet, which is the exact
    // race this class exists to prevent.
    await session.waitFor(/\S/, 15000)
    return session
  }

  /** Pipes output into the transcript and to the live listener. */
  private consume(): void {
    void this.process.output
      .pipeTo(
        new WritableStream({
          write: (chunk) => {
            this.transcript += chunk
            if (JSH_INTERNAL_ERROR.test(chunk)) {
              this.broken ??=
                'jsh reported an internal error; job control is no longer reliable'
            }
            this.onData?.(chunk)
          },
        })
      )
      .catch(() => {
        /* the stream ends when the shell exits */
      })
  }

  /** Resolves once `pattern` appears in the transcript. */
  private waitFor(pattern: RegExp, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs

    return new Promise((resolve, reject) => {
      const poll = (): void => {
        if (pattern.test(this.transcript)) return resolve()
        if (Date.now() > deadline) {
          return reject(new Error(`timed out waiting for ${pattern}`))
        }
        setTimeout(poll, 20)
      }
      poll()
    })
  }

  /**
   * Resolves when `pattern` appears or `abort` returns true.
   *
   * @returns `true` if `abort` ended the wait, `false` if the pattern did.
   */
  private waitForEither(
    pattern: RegExp,
    abort: () => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    return new Promise((resolve, reject) => {
      const poll = (): void => {
        if (pattern.test(this.transcript)) return resolve(false)
        if (abort()) return resolve(true)
        if (Date.now() > deadline) {
          return reject(new Error(`timed out waiting for ${pattern}`))
        }
        setTimeout(poll, 20)
      }
      poll()
    })
  }

  private async write(data: string): Promise<void> {
    const writer = this.process.input.getWriter()
    try {
      await writer.write(data)
    } finally {
      writer.releaseLock()
    }
  }

  /**
   * Adds work to the single write queue.
   *
   * Everything that touches the shell's input goes through here, so ordering is
   * a property of the class rather than something callers must remember. A
   * failed item does not poison the queue for the next one.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  /**
   * Runs one command and waits for it to finish.
   *
   * Completion is detected with a per-call marker rather than by guessing at
   * the prompt: the marker is split across a quote boundary so the terminal's
   * echo of the typed line cannot match it, and only the executed output can.
   *
   * @throws If the session is closed, already broken, or the command outruns
   *   `timeoutMs`.
   */
  exec(
    command: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS
  ): Promise<ShellExecResult> {
    return this.enqueue(async () => {
      this.assertUsable()

      const id = `WCSH_${++this.sequence}`
      const start = this.transcript.length
      const interruptsBefore = this.interrupts
      // `$?` is captured immediately after the command so the marker carries
      // the command's own status rather than echo's.
      await this.write(`${command}; echo "WCSH""_${this.sequence}_EXIT:$?"\n`)

      const marker = new RegExp(`${id}_EXIT:(\\d+)`)
      // An interrupt abandons the rest of the command list, so the completion
      // marker never arrives. Waiting for it anyway would hang until the
      // timeout — so treat being interrupted as its own way to finish.
      const wasInterrupted = await this.waitForEither(
        marker,
        () => this.interrupts > interruptsBefore,
        timeoutMs
      )

      if (wasInterrupted && !marker.test(this.transcript.slice(start))) {
        // Sending Ctrl-C is not evidence that Ctrl-C worked. On a shell whose
        // job control has died the byte is accepted and nothing happens, so
        // resolving here would report a command as cancelled while it is in
        // fact still running and still holding the terminal.
        await this.requireInterruptTookEffect(marker, start)
      }

      const produced = this.transcript.slice(start)
      const match = marker.exec(produced)

      return {
        output: stripMarkerLines(produced, id, command),
        exitCode: match ? Number(match[1]) : null,
        interrupted: wasInterrupted && !match,
      }
    })
  }

  /**
   * Waits for visible proof that an interrupt landed: either the shell echoed
   * the interrupt, or the command completed anyway (it finished on its own just
   * as the interrupt arrived).
   *
   * @throws And marks the session broken if neither appears.
   */
  private async requireInterruptTookEffect(
    marker: RegExp,
    start: number
  ): Promise<void> {
    const deadline = Date.now() + this.interruptGraceMs

    for (;;) {
      const produced = this.transcript.slice(start)
      if (/\^C/.test(produced) || marker.test(produced)) return

      if (Date.now() > deadline) {
        this.broken ??=
          'an interrupt was sent but never took effect; job control is dead'
        throw new Error(this.broken)
      }

      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /**
   * Actively proves job control still works, by running a command that never
   * ends, interrupting it, and requiring the shell to accept another command
   * afterwards.
   *
   * This is the authoritative check and the only one that reads no strings from
   * jsh at all. On a broken shell the interrupted process keeps holding the
   * terminal, so the follow-up command never completes — measured, not assumed
   * (a broken shell still runs commands and still reports `$?` correctly, so
   * neither of those can stand in for this).
   *
   * Costs a few seconds. Worth running when a session is handed out or comes
   * back from idle, and cheap next to the ~5s reboot it prevents.
   *
   * @returns `true` if job control works. `false` marks the session broken.
   */
  async verifyJobControl(timeoutMs = VERIFY_TIMEOUT_MS): Promise<boolean> {
    if (this.closed) throw new Error('Shell session is closed')
    if (this.broken) return false

    try {
      const running = this.exec(VERIFY_FOREGROUND, timeoutMs)
      // Let the command actually reach the foreground before interrupting it.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await this.interrupt()
      await running

      // The real test: a shell that lost job control is still blocked by the
      // process it failed to kill, so this never completes.
      const after = await this.exec('echo wc-jobcontrol-ok', timeoutMs)
      if (!after.output.includes('wc-jobcontrol-ok')) {
        this.broken ??=
          'the shell did not run a command after an interrupt; job control is dead'
        return false
      }

      return true
    } catch {
      this.broken ??=
        'job control verification did not complete; treating the session as unusable'
      return false
    }
  }

  /**
   * Sends Ctrl-C, interrupting whatever is in the foreground.
   *
   * **Deliberately bypasses the write queue.** Interrupting is only meaningful
   * while a command is running, and the queue exists precisely to hold the next
   * command until that one finishes — so queueing this would guarantee it
   * arrived too late to do anything. A terminal delivers control bytes
   * out-of-band for the same reason.
   *
   * That is safe: what breaks jsh is a *command line* written before the
   * previous finished (docs/persistent-runner.md §2.3), not a control byte.
   *
   * A Ctrl-C at an idle prompt is a no-op, exactly as in a real terminal.
   */
  async interrupt(): Promise<void> {
    this.assertUsable()

    this.interrupts++
    await this.write(String.fromCharCode(3))
  }

  /** Tells the shell its terminal was resized. */
  resize(dimensions: TerminalSize): void {
    this.process.resize(dimensions)
  }

  /**
   * Why this session can no longer be trusted, or `null` while it is healthy.
   *
   * A daemon should treat a non-null value as a reset trigger: the shell will
   * keep accepting commands, so nothing else will reveal the problem.
   */
  get brokenReason(): string | null {
    return this.broken
  }

  /** Everything the shell has printed since it opened. */
  get fullTranscript(): string {
    return this.transcript
  }

  private assertUsable(): void {
    if (this.closed) throw new Error('Shell session is closed')
    if (this.broken) throw new Error(`Shell session is broken: ${this.broken}`)
  }

  /** Terminates the shell. Safe to call more than once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.process.kill()
  }
}

/**
 * Removes the echoed command line and the completion marker, leaving what the
 * command actually printed.
 *
 * Only the *first* line carrying the command is dropped: that one is the
 * terminal echoing the keystrokes back. Later occurrences are the command's own
 * output — a `grep` for its own pattern, say — and removing those would quietly
 * corrupt the result.
 */
export function stripMarkerLines(
  produced: string,
  id: string,
  command: string
): string {
  let echoDropped = false

  return produced
    .split('\n')
    .filter((line) => {
      if (line.includes(id)) return false
      if (!echoDropped && line.includes(command)) {
        echoDropped = true
        return false
      }
      return true
    })
    .join('\n')
}
