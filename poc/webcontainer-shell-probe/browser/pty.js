// Pseudoterminal helpers and probe markers.
//
// Split out of probe.js so it carries no WebContainer import and can be unit
// tested (see ../pty.test.mjs). The marker trick below is the one piece of this
// probe that can silently produce a FALSE PASS, so it is the piece that most
// needs a test.

/** Default ceiling for anything that waits on the container. */
export const TIMEOUT_MS = 15000

/** Boot pulls the runtime over the network, so it gets a longer leash. */
export const BOOT_TIMEOUT_MS = 60000

// A pseudoterminal echoes back whatever is typed into it. So if the probe typed
// `echo WCPROBE_STDIN_OK`, the marker would land in the transcript whether or
// not the shell ever executed anything — the check would pass against a shell
// that is completely wedged.
//
// Splitting the marker across a string boundary defeats that: the echoed
// keystrokes contain `WCPROBE""_STDIN_OK` (with the quotes), while only the
// shell's *executed* output collapses to the bare `WCPROBE_STDIN_OK`. A match
// therefore proves execution, not echo.
export const STDIN_MARKER = 'WCPROBE_STDIN_OK'
export const STDIN_TYPED = 'echo "WCPROBE""_STDIN_OK"\n'

export const SIGINT_MARKER = 'WCPROBE_SURVIVED_SIGINT'
export const SIGINT_TYPED = 'echo "WCPROBE""_SURVIVED_SIGINT"\n'

export const CWD_MARKER = 'WCPROBE_CWD_OK'
export const CWD_TYPED = 'pwd && echo "WCPROBE""_CWD_OK"\n'

// The Ctrl-C check must not fire until the victim process is genuinely in the
// foreground. Sleeping a guessed number of milliseconds is what made the first
// version of that check flaky, so the process announces itself instead.
export const FOREGROUND_MARKER = 'WCPROBE_FOREGROUND_READY'
export const FOREGROUND_TYPED =
  'node -e \'console.log("WCPROBE" + "_FOREGROUND_READY"); setInterval(() => {}, 1000)\'\n'

/**
 * Never written to anything. If it ever shows up in a transcript, the probe is
 * not reading what it thinks it is and every other result becomes suspect.
 */
export const NEVER_SENT = 'WCPROBE_NEVER_SENT_MARKER'

// Built from char codes on purpose. A literal 0x03 or 0x1b in source is an
// invisible byte that an editor, a linter or a copy-paste can quietly eat —
// and losing it would turn these two checks into no-ops that always pass.
export const CTRL_C = String.fromCharCode(3)
export const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[')

/** Rejects after `ms`, for racing against anything that can hang. */
export function timeout(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
  )
}

/**
 * Attaches to a process's output stream and lets callers wait for a pattern.
 *
 * The whole transcript is retained, because several checks need to assert a
 * pattern is *absent* from everything seen so far.
 *
 * @param proc Anything with an `output` ReadableStream — a WebContainerProcess,
 *   or a stub in tests.
 */
export function attach(proc) {
  let transcript = ''
  const waiters = new Set()

  proc.output
    .pipeTo(
      new WritableStream({
        write(chunk) {
          transcript += chunk
          for (const w of [...waiters]) {
            if (w.pattern.test(transcript)) {
              waiters.delete(w)
              w.resolve(transcript)
            }
          }
        },
      })
    )
    .catch(() => {
      /* the stream closes when the process exits; nothing to do */
    })

  return {
    get transcript() {
      return transcript
    },
    /** Resolves once `pattern` appears in the transcript; rejects on timeout. */
    waitFor(pattern, ms = TIMEOUT_MS) {
      if (pattern.test(transcript)) return Promise.resolve(transcript)
      return new Promise((resolve, reject) => {
        const w = { pattern, resolve }
        waiters.add(w)
        setTimeout(() => {
          if (waiters.delete(w)) {
            reject(new Error(`timed out waiting for ${pattern}`))
          }
        }, ms)
      })
    },
  }
}

/** Writes to a process's pseudoterminal stdin. */
export async function send(proc, text) {
  const writer = proc.input.getWriter()
  await writer.write(text)
  writer.releaseLock()
}

/** Strips ANSI escape sequences so shell output can be parsed. */
export function stripAnsi(text) {
  return text.replace(
    new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g'),
    ''
  )
}

let sequence = 0

/**
 * Runs one command inside a live shell session and returns just its output.
 *
 * Needed because the runtime's `fs` API cannot see the system filesystem — the
 * only way to inventory what is installed is to ask the shell. Completion is
 * detected with a per-call marker rather than a sleep, so slow commands are
 * waited out and fast ones are not padded.
 *
 * The marker is split across a quote boundary for the same reason the probe's
 * other markers are: the terminal echoes the keystrokes, so an unsplit marker
 * would signal completion the instant the line was typed.
 */
export async function runInShell(proc, io, command, ms = TIMEOUT_MS) {
  const n = ++sequence
  const marker = `WCPROBE_DONE_${n}`
  const start = io.transcript.length
  await send(proc, `${command}; echo "WCPROBE""_DONE_${n}"\n`)
  await io.waitFor(new RegExp(marker), ms)
  // Drop the echoed command line and the marker itself; keep what ran.
  return stripAnsi(io.transcript.slice(start))
    .split('\n')
    .filter((line) => !line.includes(command) && !line.includes(marker))
    .join('\n')
}
