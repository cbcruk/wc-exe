// End-to-end check for the bridge against a real WebContainer.
//
// Unit tests cover the pure pieces (output buffering, error formatting), but
// nothing about `page.evaluate` round-trips, spawn options actually reaching
// the process, or a kill actually killing can be proven without booting the
// thing. This is that proof.
//
// Not part of `vitest run`: it needs a desktop session whose default browser
// runs WebContainer — wc-exe opens a tab rather than launching one — and
// outbound network
// access to StackBlitz's runtime hosts, so it stays an explicit local step.
//
// Usage:
//   pnpm build && node test/integration/bridge.mjs

import path from 'node:path'
import {
  startServer,
  WCBrowser,
  listProjectFiles,
  readProjectFileBytes,
} from '../../dist/index.js'

const repoRoot = path.dirname(path.dirname(import.meta.dirname))
const source = path.join(repoRoot, 'test/fixtures/sample-vite-app')
const handlers = {
  listFiles: () => listProjectFiles(source),
  readFile: (p) => readProjectFileBytes(source, p),
}

const info = await startServer(handlers)
const browser = new WCBrowser({ verbose: false })
let failures = 0

const check = (name, ok, detail) => {
  console.log(
    `[${ok ? ' OK ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`
  )
  if (!ok) failures++
}

try {
  await browser.launch(info.url)
  await browser.mountFromServer()

  // 0. byte fidelity of mounted files.
  //
  // WebContainer 1.6.1 corrupted non-ASCII content on mount: bytes came back
  // decoded as Windows-1252 and truncated (0x98 -> 0xDC, 0x85 -> 0x26). Fixed
  // upstream, but it silently broke every project with non-ASCII text in it,
  // and nothing here would have noticed — the fixtures are pure ASCII.
  const koreanHex = Buffer.from('옵션을 노드 그래프로 조립', 'utf8').toString(
    'hex'
  )
  const mountedHex = await browser.runCommand('node', [
    '-e',
    "const fs=require('fs');console.log('H='+(fs.existsSync('utf8-marker.txt')?fs.readFileSync('utf8-marker.txt').toString('hex'):'missing'))",
  ])
  check(
    'non-ASCII file content survives mounting',
    mountedHex.output.includes(koreanHex),
    /H=(\S*)/.exec(mountedHex.output)?.[1]?.slice(0, 80)
  )

  // 0b. the runtime interface mirrors WebContainer's shape; check the members
  // that were added for that actually work against a real container.
  const described = await browser.describeRuntime()
  check(
    'runtime reports its working directory',
    described.workdir.startsWith('/'),
    described.workdir
  )
  check(
    'runtime reports the PATH processes inherit',
    described.path.includes('/bin'),
    described.path
  )

  // 1. output capture
  const echo = await browser.runCommand('echo', ['CAPTURE_MARKER_OK'])
  check(
    'captures output',
    echo.output.includes('CAPTURE_MARKER_OK'),
    JSON.stringify(echo.output.trim())
  )
  check('reports exit code', echo.exitCode === 0, `exitCode=${echo.exitCode}`)
  check('reports no truncation for small output', echo.truncated === false)

  // 2. non-zero exit resolves with output rather than throwing
  const bad = await browser.runCommand('ls', ['/definitely-not-here'])
  check(
    'non-zero exit resolves',
    bad.exitCode !== 0,
    `exitCode=${bad.exitCode}`
  )
  check(
    'failure output is captured',
    bad.output.trim().length > 0,
    JSON.stringify(bad.output.trim().slice(0, 80))
  )

  // 3. spawn options: cwd + env
  const env = await browser.runCommand(
    'node',
    ['-e', 'console.log("ENV=" + process.env.VERIFY_VAR)'],
    { env: { VERIFY_VAR: 'yes' } }
  )
  check('env option reaches the process', env.output.includes('ENV=yes'))

  const term = await browser.runCommand(
    'node',
    ['-e', 'console.log("COLS=" + process.stdout.columns)'],
    { terminal: { cols: 123, rows: 40 } }
  )
  check(
    'terminal option reaches the process',
    term.output.includes('COLS=123'),
    JSON.stringify(term.output.trim())
  )

  // 4. explicit cancellation via handle
  const handle = 'verify-kill'
  const longRun = browser.runCommand(
    'node',
    ['-e', 'setInterval(() => {}, 1000)'],
    { handle }
  )
  await new Promise((r) => setTimeout(r, 2000))
  const killed = await browser.killCommand(handle)
  check('killCommand reports a match', killed === true)
  const killResult = await Promise.race([
    longRun,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('never exited')), 10000)
    ),
  ])
  check(
    'killed command exits',
    typeof killResult.exitCode === 'number',
    `exitCode=${killResult.exitCode}`
  )

  // killing an unknown handle is a miss, not an error
  check(
    'killCommand on stale handle returns false',
    (await browser.killCommand(handle)) === false
  )

  // 5. timeout kills rather than orphaning
  let timedOut = false
  const before = Date.now()
  try {
    await browser.runCommand('node', ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 2000,
    })
  } catch (err) {
    timedOut = /timed out/.test(err.message)
  }
  check('timeout throws', timedOut, `${Date.now() - before}ms`)

  // If the timeout really killed it, the runtime is still responsive.
  const after = await browser.runCommand('echo', ['STILL_RESPONSIVE'])
  check(
    'runtime responsive after timeout',
    after.output.includes('STILL_RESPONSIVE')
  )

  // 6. interactive shell session
  const streamed = []
  await browser.openShell('main', {
    cols: 100,
    rows: 30,
    onData: (chunk) => streamed.push(chunk),
  })

  const hi = await browser.shellExec('main', 'echo SHELL_MARKER_OK')
  check(
    'shell runs a command',
    hi.output.includes('SHELL_MARKER_OK'),
    JSON.stringify(hi.output.trim())
  )
  check(
    'shell reports exit status',
    hi.exitCode === 0,
    `exitCode=${hi.exitCode}`
  )
  check(
    'shell output streams to the host',
    streamed.join('').includes('SHELL_MARKER_OK'),
    `${streamed.length} chunks`
  )

  const bad2 = await browser.shellExec('main', 'ls /definitely-not-here')
  check(
    'shell reports a non-zero status',
    bad2.exitCode !== 0,
    `exitCode=${bad2.exitCode}`
  )

  // state persists across commands — this is what makes it a session
  await browser.shellExec('main', 'mkdir -p session-probe')
  await browser.shellExec('main', 'cd session-probe')
  const pwd = await browser.shellExec('main', 'pwd')
  check(
    'shell keeps cwd between commands',
    pwd.output.includes('session-probe'),
    JSON.stringify(pwd.output.trim())
  )

  check('shell is healthy', (await browser.shellBrokenReason('main')) === null)

  // 6b. the case that motivated all of this: after many commands, does the
  // session still have working job control?
  for (let i = 0; i < 25; i++) {
    await browser.shellExec('main', `echo warm${i}`)
  }
  check(
    'still healthy after 25 commands',
    (await browser.shellBrokenReason('main')) === null,
    await browser.shellBrokenReason('main')
  )

  // Ctrl-C is only meaningful against something running, so start a command
  // that will not end on its own and cut it short.
  const longCommand = browser.shellExec(
    'main',
    'node -e "setInterval(() => {}, 1000)"'
  )
  await new Promise((r) => setTimeout(r, 2500))
  await browser.shellInterrupt('main')

  const interruptedResult = await Promise.race([
    longCommand,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('exec never returned')), 15000)
    ),
  ]).catch((err) => ({ error: err.message }))

  check(
    'Ctrl-C cuts a running command short on an aged session',
    interruptedResult.interrupted === true,
    JSON.stringify(interruptedResult).slice(0, 120)
  )
  check(
    'still healthy after Ctrl-C',
    (await browser.shellBrokenReason('main')) === null,
    await browser.shellBrokenReason('main')
  )

  // An idle Ctrl-C is a no-op, not a fault.
  await browser.shellInterrupt('main')
  check(
    'idle Ctrl-C does not break the session',
    (await browser.shellBrokenReason('main')) === null
  )

  const afterInterrupt = await browser.shellExec('main', 'echo AFTER_INTERRUPT')
  check(
    'shell usable after Ctrl-C',
    afterInterrupt.output.includes('AFTER_INTERRUPT'),
    JSON.stringify(afterInterrupt.output.trim().slice(-60))
  )

  // The authoritative health check: interrupt a real command and require the
  // shell to accept another one afterwards. Reads no jsh error strings.
  const verified = await browser.shellVerifyJobControl('main')
  check('verifyJobControl passes on a healthy aged session', verified === true)

  await browser.closeShell('main')

  // 6c. and now the negative control — a deliberately broken shell must be
  // caught. Without this, "verify passes" only proves it can say yes.
  await browser.openShell('broken')
  const brokenBefore = await browser.shellBrokenReason('broken')
  check('a fresh shell starts healthy', brokenBefore === null)

  // Two command lines in one write. ShellSession's queue cannot produce this,
  // but an embedded newline smuggles it through — which gives a negative
  // control without adding a test-only "break yourself" method to the API.
  try {
    await browser.shellExec('broken', 'echo one\necho two')
  } catch (err) {
    console.log('   (exec threw:', err.message.slice(0, 80), ')')
  }

  // Whether jsh prints its internal error varies between runs, so which signal
  // catches the damage varies too. Asserting on one mechanism would make this
  // flaky. The invariant that actually matters is weaker and firmer: a damaged
  // session must never be reported as healthy.
  const heuristicSaw = await browser.shellBrokenReason('broken')
  console.log(
    `   string heuristic ${heuristicSaw ? 'caught it' : 'MISSED it'} — ${JSON.stringify(heuristicSaw)}`
  )

  const verifiedBroken = await browser.shellVerifyJobControl('broken')
  check(
    'verifyJobControl rejects the damaged session',
    verifiedBroken === false
  )
  check(
    'the damaged session ends up marked broken',
    (await browser.shellBrokenReason('broken')) !== null
  )

  // And once known bad, it refuses work rather than quietly doing it wrong.
  let refused = false
  try {
    await browser.shellExec('broken', 'echo SHOULD_NOT_RUN')
  } catch (err) {
    refused = /broken/.test(err.message)
  }
  check('a broken session refuses further commands', refused)

  await browser.closeShell('broken')

  // 7. the actual build still works
  const install = await browser.runCommand('npm', ['install'])
  check(
    'npm install succeeds',
    install.exitCode === 0,
    `exitCode=${install.exitCode}`
  )
  const build = await browser.runCommand('npm', ['run', 'build'])
  check(
    'npm run build succeeds',
    build.exitCode === 0,
    `exitCode=${build.exitCode}`
  )
  check(
    'build output captured',
    build.output.includes('vite'),
    JSON.stringify(build.output.trim().slice(-120))
  )
} finally {
  await browser.close()
  await new Promise((r) => info.server.close(() => r()))
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
