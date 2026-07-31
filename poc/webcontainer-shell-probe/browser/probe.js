// Runs inside the page. Boots a WebContainer and asks one question:
// how much of an SSH session can you actually get out of it?
//
// The WebContainer API advertises a pseudoterminal — `process.input`,
// `resize()`, `kill()`, `terminal: {cols, rows}`. This exercises every one of
// those and inventories what is actually runnable inside, then hands a JSON
// report back to the host driver.
//
// Every check is written so it can FAIL. Several carry deliberate negative
// controls (a marker that was never sent, a binary that cannot exist): if a
// negative control "passes", the probe reports itself broken rather than
// reporting a green result. A probe you cannot distrust is worthless.

import { WebContainer } from '/vendor/webcontainer/index.js'
import {
  ANSI_ESCAPE,
  BOOT_TIMEOUT_MS,
  CTRL_C,
  CWD_MARKER,
  CWD_TYPED,
  NEVER_SENT,
  SIGINT_MARKER,
  SIGINT_TYPED,
  STDIN_MARKER,
  STDIN_TYPED,
  TIMEOUT_MS,
  attach,
  send,
  timeout,
} from './pty.js'

const results = []

/**
 * @param status 'pass' the capability is there | 'fail' it is not |
 *   'error' the check itself blew up | 'skip' a prerequisite was missing |
 *   'info' no pass/fail, just a recorded fact |
 *   'broken' a negative control fired, so no other result here is trustworthy
 */
function record(id, question, status, detail) {
  results.push({ id, question, status, detail })
  console.log(`[probe] ${status.toUpperCase()} ${id} — ${detail}`)
}

/** Runs a check, turning any throw into an `error` result instead of a hang. */
async function check(id, question, fn) {
  try {
    const { status, detail } = await fn()
    record(id, question, status, detail)
  } catch (err) {
    record(id, question, 'error', err?.message ?? String(err))
  }
}

/**
 * Runs a command to completion and returns its transcript and exit code.
 * Used for the one-shot checks that do not need an interactive session.
 */
async function runToExit(wc, command, args, options = {}, ms = TIMEOUT_MS) {
  const proc = await wc.spawn(command, args, options)
  const io = attach(proc)
  const exitCode = await Promise.race([
    proc.exit,
    timeout(ms, `${command} ${args.join(' ')}`),
  ])
  return { exitCode, transcript: io.transcript }
}

const SHELL_CANDIDATES = ['jsh', 'sh', 'bash', 'zsh', 'ash', 'dash']

/** Commands worth knowing about for an SSH-like session, plus a control. */
const BINARY_CANDIDATES = [
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'git',
  'ls',
  'cat',
  'echo',
  'env',
  'which',
  'grep',
  'sed',
  'curl',
  'wget',
  'tar',
  'ps',
  'kill',
  'chmod',
  'vi',
  'python3',
  'gcc',
]
const IMPOSSIBLE_BINARY = 'wcprobe-definitely-not-a-real-binary'

async function main() {
  // Reported first because it is decisive and instant: without cross-origin
  // isolation WebContainer cannot boot at all, and every later result would be
  // a confusing timeout instead of one clear cause.
  record(
    'env.isolated',
    'Is the page cross-origin isolated?',
    self.crossOriginIsolated ? 'pass' : 'fail',
    self.crossOriginIsolated
      ? 'COOP/COEP are in effect, so SharedArrayBuffer is available'
      : 'NOT isolated — WebContainer cannot boot; check the COOP/COEP headers'
  )

  console.log('[probe] module loaded; booting WebContainer...')
  const bootStart = performance.now()
  // Boot reaches out to StackBlitz's runtime hosts. When that is blocked it
  // does not reject, it simply never settles — so a bare hang would surface as
  // an opaque driver timeout. Name the likely cause instead.
  const wc = await Promise.race([
    WebContainer.boot(),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              'WebContainer.boot() never settled after ' +
                `${BOOT_TIMEOUT_MS}ms. It is usually one of: no outbound network ` +
                "access to StackBlitz's runtime hosts, or the page is not " +
                'cross-origin isolated (see the env.isolated result above).'
            )
          ),
        BOOT_TIMEOUT_MS
      )
    ),
  ])
  const bootMs = Math.round(performance.now() - bootStart)
  record('boot', 'Does WebContainer boot?', 'info', `booted in ${bootMs}ms`)

  // ---------------------------------------------------------------- environment

  record(
    'env.workdir',
    'What is the working directory?',
    'info',
    String(wc.workdir)
  )
  record('env.path', 'What is the default PATH?', 'info', String(wc.path))

  await check('env.inventory', 'What is actually on PATH?', async () => {
    const dirs = String(wc.path).split(':').filter(Boolean)
    const found = {}
    let total = 0
    for (const dir of dirs) {
      try {
        const entries = await wc.fs.readdir(dir, { withFileTypes: true })
        const names = entries.filter((e) => e.isFile()).map((e) => e.name)
        found[dir] = names.sort()
        total += names.length
      } catch (err) {
        found[dir] = `<unreadable: ${err?.message ?? err}>`
      }
    }
    return {
      status: total > 0 ? 'pass' : 'fail',
      detail: JSON.stringify(found),
    }
  })

  // ---------------------------------------------------------------- shell discovery

  let shell = null
  await check('shell.discover', 'Which shells can be spawned?', async () => {
    const report = {}
    for (const name of SHELL_CANDIDATES) {
      try {
        const proc = await wc.spawn(name, [], {
          terminal: { cols: 80, rows: 24 },
        })
        const io = attach(proc)
        // An interactive shell sits there waiting for input; a missing binary
        // exits immediately, usually 127.
        const outcome = await Promise.race([
          proc.exit.then((code) => ({ exited: true, code })),
          new Promise((r) => setTimeout(() => r({ exited: false }), 2000)),
        ])
        if (outcome.exited) {
          report[name] =
            `exited ${outcome.code}: ${io.transcript.trim().slice(0, 120)}`
        } else {
          report[name] = 'stayed running (interactive)'
          if (!shell) shell = name
          proc.kill()
        }
      } catch (err) {
        report[name] = `spawn threw: ${err?.message ?? err}`
      }
    }
    return {
      status: shell ? 'pass' : 'fail',
      detail: `${shell ? `interactive shell: ${shell}. ` : 'no interactive shell found. '}${JSON.stringify(report)}`,
    }
  })

  // ---------------------------------------------------------------- binaries

  await check(
    'binaries.probe',
    'Which well-known commands exist?',
    async () => {
      const present = []
      const absent = []
      for (const name of [...BINARY_CANDIDATES, IMPOSSIBLE_BINARY]) {
        try {
          const { exitCode, transcript } = await runToExit(
            wc,
            name,
            ['--version'],
            {},
            8000
          )
          // 127 and "not found" both mean the binary is missing; anything else
          // means it ran, even if it rejected --version.
          const missing =
            exitCode === 127 || /not found|no such file/i.test(transcript)
          ;(missing ? absent : present).push(name)
        } catch {
          absent.push(name)
        }
      }
      // Negative control: a name that cannot exist must land in `absent`.
      if (present.includes(IMPOSSIBLE_BINARY)) {
        return {
          status: 'broken',
          detail:
            `the impossible binary "${IMPOSSIBLE_BINARY}" was reported present, ` +
            `so this detection cannot tell present from absent. present=${JSON.stringify(present)}`,
        }
      }
      return {
        status: present.length > 0 ? 'pass' : 'fail',
        detail: `present=${JSON.stringify(present)} absent=${JSON.stringify(absent.filter((n) => n !== IMPOSSIBLE_BINARY))}`,
      }
    }
  )

  // ---------------------------------------------------------------- the PTY itself

  // Everything below needs a live interactive shell.
  const needShell = (fn) => async () =>
    shell
      ? await fn()
      : { status: 'skip', detail: 'no interactive shell was found' }

  /** The long-lived session the interactive checks share. */
  let session = null
  let sessionIo = null

  await check(
    'pty.stdin',
    'Does typing into the pseudoterminal actually run commands?',
    needShell(async () => {
      session = await wc.spawn(shell, [], { terminal: { cols: 80, rows: 24 } })
      sessionIo = attach(session)
      await send(session, STDIN_TYPED)
      await sessionIo.waitFor(new RegExp(STDIN_MARKER))
      return {
        status: 'pass',
        detail: 'shell executed a command typed into process.input',
      }
    })
  )

  await check(
    'pty.echo',
    'Does the terminal echo what is typed, like a real tty?',
    needShell(async () => {
      if (!sessionIo) return { status: 'skip', detail: 'no session' }
      // The quoted form is only present if the raw keystrokes came back.
      const echoed = /echo "WCPROBE""_STDIN_OK"/.test(sessionIo.transcript)
      return {
        status: echoed ? 'pass' : 'fail',
        detail: echoed
          ? 'input is echoed back on the output stream'
          : 'no echo of typed input — the caller would have to render it',
      }
    })
  )

  await check(
    'pty.ansi',
    'Does output carry ANSI escapes (colors, cursor control)?',
    needShell(async () => {
      if (!sessionIo) return { status: 'skip', detail: 'no session' }
      const hasAnsi = ANSI_ESCAPE.test(sessionIo.transcript)
      return {
        status: hasAnsi ? 'pass' : 'fail',
        detail: hasAnsi
          ? 'escape sequences present — a real terminal emulator is warranted'
          : 'no escape sequences seen in this transcript',
      }
    })
  )

  await check(
    'pty.state',
    'Does the session keep state between inputs (cd, then pwd)?',
    needShell(async () => {
      if (!session || !sessionIo)
        return { status: 'skip', detail: 'no session' }
      await wc.fs.mkdir('probe-cd', { recursive: true })
      await send(session, 'cd probe-cd\n')
      await send(session, CWD_TYPED)
      const transcript = await sessionIo.waitFor(new RegExp(CWD_MARKER))
      const inDir = /probe-cd/.test(transcript)
      return {
        status: inDir ? 'pass' : 'fail',
        detail: inDir
          ? 'cd persisted across separate writes to stdin — a session, not one-shot commands'
          : 'pwd did not report the directory we cd-ed into',
      }
    })
  )

  await check(
    'pty.sigint',
    'Does Ctrl-C kill the foreground command but leave the shell alive?',
    needShell(async () => {
      if (!session || !sessionIo)
        return { status: 'skip', detail: 'no session' }
      await send(session, 'node -e "setInterval(() => {}, 1000)"\n')
      // Give the child a moment to actually become the foreground process.
      await new Promise((r) => setTimeout(r, 1500))
      await send(session, CTRL_C)
      await send(session, SIGINT_TYPED)
      await sessionIo.waitFor(new RegExp(SIGINT_MARKER))
      return {
        status: 'pass',
        detail:
          'Ctrl-C interrupted the foreground process and the shell kept accepting input',
      }
    })
  )

  // ---------------------------------------------------------------- terminal control

  await check(
    'terminal.size',
    'Does the terminal option set the reported terminal width?',
    async () => {
      const { transcript } = await runToExit(
        wc,
        'node',
        ['-e', 'console.log("COLS=" + process.stdout.columns)'],
        { terminal: { cols: 100, rows: 30 } }
      )
      const match = /COLS=(\d+)/.exec(transcript)
      if (!match) {
        return {
          status: 'fail',
          detail: `no width reported; stdout may not be a tty. transcript=${transcript.trim().slice(0, 200)}`,
        }
      }
      return {
        status: match[1] === '100' ? 'pass' : 'fail',
        detail: `requested 100 columns, process saw ${match[1]}`,
      }
    }
  )

  await check(
    'terminal.resize',
    'Does resize() reach the running process as a resize event?',
    async () => {
      const proc = await wc.spawn(
        'node',
        [
          '-e',
          'process.stdout.on("resize", () => console.log("RESIZED=" + process.stdout.columns)); setInterval(() => {}, 1000)',
        ],
        { terminal: { cols: 80, rows: 24 } }
      )
      const io = attach(proc)
      try {
        await new Promise((r) => setTimeout(r, 1000))
        proc.resize({ cols: 132, rows: 43 })
        await io.waitFor(/RESIZED=132/, 8000)
        return {
          status: 'pass',
          detail: 'the process received a resize event with the new width',
        }
      } finally {
        proc.kill()
      }
    }
  )

  await check(
    'process.kill',
    'Does kill() terminate a long-running process?',
    async () => {
      const proc = await wc.spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
      await new Promise((r) => setTimeout(r, 1000))
      proc.kill()
      const code = await Promise.race([proc.exit, timeout(8000, 'kill()')])
      return { status: 'pass', detail: `process exited with code ${code}` }
    }
  )

  // ---------------------------------------------------------------- spawn options

  await check('spawn.cwd', 'Is the cwd option honoured?', async () => {
    await wc.fs.mkdir('probe-cwd', { recursive: true })
    const { transcript } = await runToExit(
      wc,
      'node',
      ['-e', 'console.log("CWD=" + process.cwd())'],
      { cwd: 'probe-cwd' }
    )
    const match = /CWD=(\S+)/.exec(transcript)
    const ok = Boolean(match) && match[1].endsWith('probe-cwd')
    return {
      status: ok ? 'pass' : 'fail',
      detail: match ? `process.cwd() = ${match[1]}` : 'no cwd reported',
    }
  })

  await check('spawn.env', 'Is the env option honoured?', async () => {
    const { transcript } = await runToExit(
      wc,
      'node',
      ['-e', 'console.log("ENV=" + process.env.WCPROBE_ENV)'],
      { env: { WCPROBE_ENV: 'yes' } }
    )
    const ok = /ENV=yes/.test(transcript)
    return {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? 'the spawned process saw the injected variable'
        : `variable not visible. transcript=${transcript.trim().slice(0, 200)}`,
    }
  })

  await check(
    'spawn.concurrent',
    'Can two processes run at the same time?',
    async () => {
      const [a, b] = await Promise.all([
        wc.spawn('node', [
          '-e',
          'setTimeout(() => console.log("A_DONE"), 1500)',
        ]),
        wc.spawn('node', [
          '-e',
          'setTimeout(() => console.log("B_DONE"), 1500)',
        ]),
      ])
      const ioA = attach(a)
      const ioB = attach(b)
      const start = performance.now()
      await Promise.race([
        Promise.all([a.exit, b.exit]),
        timeout(TIMEOUT_MS, 'concurrent spawns'),
      ])
      const elapsed = Math.round(performance.now() - start)
      const bothRan =
        /A_DONE/.test(ioA.transcript) && /B_DONE/.test(ioB.transcript)
      return {
        status: bothRan ? 'pass' : 'fail',
        detail: `both finished in ${elapsed}ms (sequential would be ~3000ms)`,
      }
    }
  )

  // ---------------------------------------------------------------- negative control

  // Run last, over everything the session ever saw.
  const leaked = sessionIo
    ? new RegExp(NEVER_SENT).test(sessionIo.transcript)
    : false
  record(
    'control.never_sent',
    'Negative control: does a marker we never sent stay absent?',
    leaked ? 'broken' : 'pass',
    leaked
      ? 'a marker that was never written appeared in the transcript — DISTRUST every result above'
      : 'absent, as it must be'
  )

  session?.kill()

  return { bootMs, shell, results }
}

main()
  .then((report) => {
    window.__PROBE_RESULT__ = report
    window.__PROBE_DONE__ = true
  })
  .catch((err) => {
    window.__PROBE_RESULT__ = {
      fatal: err?.message ?? String(err),
      results,
    }
    window.__PROBE_DONE__ = true
  })
