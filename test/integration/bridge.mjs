// End-to-end check for the bridge against a real WebContainer.
//
// Unit tests cover the pure pieces (output buffering, error formatting), but
// nothing about `page.evaluate` round-trips, spawn options actually reaching
// the process, or a kill actually killing can be proven without booting the
// thing. This is that proof.
//
// Not part of `vitest run`: it needs a Chrome binary and outbound network
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

  // 6. the actual build still works
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
