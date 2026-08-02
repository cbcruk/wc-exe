import { describe, expect, it } from 'vitest'
import { ShellSession, stripMarkerLines } from './shell-session'
import type { Runtime, RuntimeProcess, SpawnOptions } from './runtime.types'

/**
 * A shell stand-in that records every write and lets the test decide what comes
 * back. Nothing here needs a container, which is the point: the ordering
 * guarantee is a property of ShellSession, not of WebContainer.
 */
function fakeShell() {
  const writes: string[] = []
  let emit!: (chunk: string) => void

  const output = new ReadableStream<string>({
    start(controller) {
      emit = (chunk) => controller.enqueue(chunk)
    },
  })

  const input = new WritableStream<string>({
    write(chunk) {
      writes.push(chunk)
    },
  })

  let killed = false
  const resizes: Array<{ cols: number; rows: number }> = []

  const process: RuntimeProcess = {
    output,
    input,
    exit: new Promise(() => {}),
    kill: () => {
      killed = true
    },
    resize: (dimensions) => {
      resizes.push(dimensions)
    },
  }

  const spawns: Array<{ command: string; options?: SpawnOptions }> = []
  const runtime = {
    spawn: async (command: string, _args: string[], options?: SpawnOptions) => {
      spawns.push({ command, options })
      return process
    },
  } as unknown as Runtime

  return {
    runtime,
    writes,
    spawns,
    resizes,
    emit: (chunk: string) => emit(chunk),
    get killed() {
      return killed
    },
  }
}

/** Emits the completion marker for the nth command, with an exit status. */
function finish(shell: ReturnType<typeof fakeShell>, n: number, code = 0) {
  shell.emit(`WCSH_${n}_EXIT:${code}\n`)
}

const flush = () => new Promise((r) => setTimeout(r, 30))

async function openSession(shell: ReturnType<typeof fakeShell>) {
  // A short grace keeps the broken-shell tests fast; the behaviour under test
  // is the same, only the deadline differs.
  const opening = ShellSession.open(shell.runtime, { interruptGraceMs: 300 })
  await flush()
  shell.emit('~/project ❯ ')
  return await opening
}

describe('ShellSession.open', () => {
  it('waits for the first prompt before returning', async () => {
    const shell = fakeShell()
    let opened = false

    const opening = ShellSession.open(shell.runtime).then((s) => {
      opened = true
      return s
    })

    await flush()
    // Nothing has been printed yet, so the shell is not listening yet.
    expect(opened).toBe(false)

    shell.emit('~/project ❯ ')
    await opening

    expect(opened).toBe(true)
  })

  it('spawns jsh with a terminal by default', async () => {
    const shell = fakeShell()
    await openSession(shell)

    expect(shell.spawns[0].command).toBe('jsh')
    expect(shell.spawns[0].options?.terminal).toEqual({ cols: 80, rows: 24 })
  })
})

describe('ShellSession serialization', () => {
  // The reason this class exists. Writing a second command line before the
  // first finished makes jsh lose job control silently.
  it('does not write the second command until the first completes', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const first = session.exec('sleep 1')
    const second = session.exec('echo second')
    await flush()

    expect(shell.writes).toHaveLength(1)
    expect(shell.writes[0]).toContain('sleep 1')

    finish(shell, 1)
    await first
    await flush()

    expect(shell.writes).toHaveLength(2)
    expect(shell.writes[1]).toContain('echo second')

    finish(shell, 2)
    await second
  })

  it('keeps ordering across many concurrent callers', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = [1, 2, 3, 4].map((n) => session.exec(`cmd${n}`))

    for (let n = 1; n <= 4; n++) {
      await flush()
      expect(shell.writes).toHaveLength(n)
      expect(shell.writes[n - 1]).toContain(`cmd${n}`)
      finish(shell, n)
    }

    await Promise.all(running)
    expect(shell.writes.map((w) => w.match(/cmd\d/)?.[0])).toEqual([
      'cmd1',
      'cmd2',
      'cmd3',
      'cmd4',
    ])
  })

  // Ctrl-C must NOT queue. The queue holds the next command until the current
  // one finishes, so a queued interrupt could only ever arrive after the thing
  // it was meant to interrupt had already ended.
  it('sends an interrupt immediately, without waiting for the running command', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = session.exec('sleep 1')
    await flush()
    expect(shell.writes).toHaveLength(1)

    await session.interrupt()
    expect(shell.writes[1]).toBe(String.fromCharCode(3))

    // A shell that honours the interrupt echoes it.
    shell.emit('^C\n')

    // The interrupted command finishes without its completion marker.
    await expect(running).resolves.toMatchObject({
      interrupted: true,
      exitCode: null,
    })
  })

  it('leaves the session usable after an interrupt', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = session.exec('sleep 1')
    await flush()
    await session.interrupt()
    shell.emit('^C\n')
    await running

    const next = session.exec('echo after')
    await flush()
    finish(shell, 2)

    await expect(next).resolves.toMatchObject({ exitCode: 0 })
  })

  it('does not let a failed command block the queue', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const failing = session.exec('hangs', 60)
    await expect(failing).rejects.toThrow(/timed out/)

    const next = session.exec('echo after')
    await flush()
    finish(shell, 2)

    await expect(next).resolves.toMatchObject({ exitCode: 0 })
  })
})

describe('ShellSession results', () => {
  it('reports the command exit status', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = session.exec('false')
    await flush()
    shell.emit('WCSH_1_EXIT:1\n')

    await expect(running).resolves.toMatchObject({
      exitCode: 1,
      interrupted: false,
    })
  })

  it('splits the marker so the terminal echo cannot complete the command', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    void session.exec('echo hi')
    await flush()

    // What the shell would echo back is exactly what we wrote. If that text
    // matched the completion marker, exec would resolve without the command
    // ever running.
    const echoed = shell.writes[0]
    expect(echoed).toContain('WCSH""_1_EXIT')
    expect(echoed).not.toMatch(/WCSH_1_EXIT:\d/)
  })
})

describe('ShellSession health', () => {
  it('is healthy to begin with', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    expect(session.brokenReason).toBeNull()
  })

  // The failure mode from docs/persistent-runner.md §2.3: after this the shell
  // still runs commands, so nothing else reveals the problem.
  it('marks itself broken when jsh reports an internal error', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    shell.emit(
      "jsh: Cannot read properties of undefined (reading 'exitCode')\n"
    )
    await flush()

    expect(session.brokenReason).toMatch(/job control/)
  })

  it('refuses further commands once broken', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    shell.emit(
      "jsh: Cannot read properties of undefined (reading 'exitCode')\n"
    )
    await flush()

    await expect(session.exec('echo hi')).rejects.toThrow(/broken/)
  })

  // A Ctrl-C at an idle prompt is a no-op in a real terminal too, and jsh
  // echoes nothing for it. Treating that silence as a broken session — which an
  // earlier version of this class did — would tear down healthy sessions and
  // make the daemon pay a full reboot for nothing.
  it('treats an interrupt at an idle prompt as a no-op, not a fault', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    await session.interrupt()

    expect(session.brokenReason).toBeNull()
    expect(shell.writes).toEqual([String.fromCharCode(3)])
  })

  it('refuses commands after close', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    session.close()

    expect(shell.killed).toBe(true)
    await expect(session.exec('echo hi')).rejects.toThrow(/closed/)
  })
})

describe('ShellSession job-control detection', () => {
  // Measured, not assumed: on a shell whose job control has died the Ctrl-C
  // byte is accepted and nothing happens. Resolving on "we sent it" would
  // report a command as cancelled while it is still running and still holding
  // the terminal.
  it('does not call a command interrupted just because Ctrl-C was sent', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = session.exec('sleep 1')
    await flush()
    await session.interrupt()
    // The shell never acknowledges — this is the broken case.

    await expect(running).rejects.toThrow(/never took effect/)
    expect(session.brokenReason).toMatch(/job control is dead/)
  })

  it('accepts the command completing on its own as proof enough', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const running = session.exec('quick')
    await flush()
    await session.interrupt()
    // It finished by itself just as the interrupt arrived. Nothing is wrong.
    finish(shell, 1)

    await expect(running).resolves.toMatchObject({ exitCode: 0 })
    expect(session.brokenReason).toBeNull()
  })

  it('verifyJobControl passes on a shell that honours interrupts', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    const verifying = session.verifyJobControl()

    // The probe command, then the interrupt it expects to land.
    await flush()
    shell.emit('^C\n')
    // Then the follow-up command that proves the shell came back.
    await new Promise((r) => setTimeout(r, 1700))
    shell.emit('wc-jobcontrol-ok\n')
    finish(shell, 2)

    await expect(verifying).resolves.toBe(true)
    expect(session.brokenReason).toBeNull()
  })

  // The distinct, string-free failure the experiment measured: on a broken
  // shell the process it failed to kill keeps holding the terminal, so the
  // NEXT command never completes even though the interrupt looked accepted.
  it('verifyJobControl fails when the interrupt lands but no command runs after it', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    // The bound must exceed the settle delay before the interrupt, or the
    // probe command times out first and this would pass for the wrong reason.
    const verifying = session.verifyJobControl(3000)

    // Acknowledge the interrupt, so the run gets past that step...
    await flush()
    shell.emit('^C\n')
    // ...but never complete the follow-up `echo wc-jobcontrol-ok`.

    await expect(verifying).resolves.toBe(false)
    expect(session.brokenReason).toBeTruthy()
  }, 15000)

  it('verifyJobControl fails when the shell never comes back', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    // Nothing is ever emitted: the interrupted process still holds the
    // terminal, which is exactly what a broken shell looks like.
    await expect(session.verifyJobControl()).resolves.toBe(false)
    expect(session.brokenReason).toBeTruthy()
  })

  it('verifyJobControl reports false without re-probing an already broken shell', async () => {
    const shell = fakeShell()
    const session = await openSession(shell)

    shell.emit(
      "jsh: Cannot read properties of undefined (reading 'exitCode')\n"
    )
    await flush()
    const writesBefore = shell.writes.length

    await expect(session.verifyJobControl()).resolves.toBe(false)
    expect(shell.writes).toHaveLength(writesBefore)
  })
})

describe('stripMarkerLines', () => {
  it('drops the echoed command line and the marker', () => {
    const produced = ['echo hi', 'hi', 'WCSH_1_EXIT:0'].join('\n')

    expect(stripMarkerLines(produced, 'WCSH_1', 'echo hi')).toBe('hi')
  })

  // Removing every line containing the command would corrupt output that
  // legitimately repeats it.
  it('keeps later lines that happen to contain the command text', () => {
    const produced = [
      'grep foo',
      'foo appears here',
      'grep foo matched twice',
      'WCSH_2_EXIT:0',
    ].join('\n')

    expect(stripMarkerLines(produced, 'WCSH_2', 'grep foo')).toBe(
      'foo appears here\ngrep foo matched twice'
    )
  })
})
