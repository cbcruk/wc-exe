import type { CommandResult } from './types.js'

// Matches CSI escape sequences. Built from a char code because a literal 0x1b
// is an invisible byte that tooling can silently eat.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g')

/** How many trailing lines of output to quote in an error message. */
const TAIL_LINES = 20

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
 * @param label Human-readable command name, e.g. `npm run build`.
 */
export function commandFailure(label: string, result: CommandResult): Error {
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

  return new Error(parts.join('\n'))
}
