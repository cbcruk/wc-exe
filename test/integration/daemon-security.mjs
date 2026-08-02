// Does the daemon's control plane actually refuse what it claims to refuse?
//
// docs/persistent-runner.md §5 is the part of this design that introduces new
// risk rather than removing it: the one-shot server existed only during a build
// and on a random port, whereas the daemon listens on a fixed port for as long
// as it runs, and it runs builds. auth.test.ts covers the guard in isolation;
// this checks the assembled, listening daemon — the bind address, the real
// token, and the routes as mounted.
//
// Usage:
//   pnpm build && node test/integration/daemon-security.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.dirname(path.dirname(import.meta.dirname))
const entry = path.join(repoRoot, 'dist/daemon/daemon-entry.js')

let failures = 0
const check = (name, ok, detail) => {
  console.log(
    `[${ok ? ' OK ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`
  )
  if (!ok) failures++
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-sec-'))
const PORT = 5413
const env = {
  ...process.env,
  WC_EXE_CACHE_DIR: work,
  WC_EXE_CACHE_PORT: String(PORT),
  WC_EXE_DAEMON_IDLE_MS: '600000',
}

const daemon = spawn(process.execPath, [entry], { env, stdio: 'ignore' })
const recordPath = path.join(work, 'daemon.json')

async function waitForRecord() {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(await fs.readFile(recordPath, 'utf8'))
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw new Error('daemon never wrote its discovery record')
}

try {
  const record = await waitForRecord()
  const base = `http://127.0.0.1:${record.port}`

  // ---- the discovery file holds the token, so its mode is load-bearing ----
  const stat = await fs.stat(recordPath)
  const mode = (stat.mode & 0o777).toString(8)
  check(
    'the discovery file is not readable by anyone else',
    mode === '600',
    `mode ${mode}`
  )
  check('the record carries a token', typeof record.token === 'string')
  check(
    'the token is long enough to be worth having',
    record.token.length >= 32,
    `${record.token.length} chars`
  )

  // ---- control plane ------------------------------------------------------
  const noToken = await fetch(`${base}/control/health`)
  check('no token is refused', noToken.status === 401, `${noToken.status}`)

  const wrongToken = await fetch(`${base}/control/health`, {
    headers: { authorization: `Bearer ${'0'.repeat(record.token.length)}` },
  })
  check(
    'a wrong token is refused',
    wrongToken.status === 401,
    `${wrongToken.status}`
  )

  const good = await fetch(`${base}/control/health`, {
    headers: { authorization: `Bearer ${record.token}` },
  })
  check('the real token is accepted', good.status === 200, `${good.status}`)

  // A page the user happens to visit can reach localhost. It cannot suppress
  // the Origin header, so this holds even if the token were to leak.
  const withOrigin = await fetch(`${base}/control/health`, {
    headers: {
      authorization: `Bearer ${record.token}`,
      origin: 'https://evil.example',
    },
  })
  check(
    'a valid token from a web page is still refused',
    withOrigin.status === 403,
    `${withOrigin.status}`
  )

  const buildFromPage = await fetch(`${base}/control/build`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record.token}`,
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: repoRoot }),
  })
  check(
    'a web page cannot start a build',
    buildFromPage.status === 403,
    `${buildFromPage.status}`
  )

  // ---- the daemon must not be reachable off this machine ------------------
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)

  if (!external) {
    console.log('   (no external IPv4 interface; skipping the bind check)')
  } else {
    let reachable = false
    try {
      const res = await fetch(
        `http://${external.address}:${record.port}/control/health`,
        {
          signal: AbortSignal.timeout(3000),
        }
      )
      reachable = res.status !== 0
    } catch {
      reachable = false
    }
    check(
      'the daemon is not listening on the external interface',
      !reachable,
      `tried ${external.address}:${record.port}`
    )
  }

  // ---- path validation is the second layer behind the token ---------------
  const authorized = {
    authorization: `Bearer ${record.token}`,
    'content-type': 'application/json',
  }

  const missing = await fetch(`${base}/control/build`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ source: path.join(work, 'does-not-exist') }),
  })
  check(
    'a nonexistent project is refused',
    missing.status === 400,
    `${missing.status}`
  )

  const notADir = await fetch(`${base}/control/build`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ source: recordPath }),
  })
  check(
    'a file rather than a directory is refused',
    notADir.status === 400,
    `${notADir.status}`
  )

  const empty = await fetch(`${base}/control/build`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ source: '' }),
  })
  check('an empty source is refused', empty.status === 400, `${empty.status}`)

  // ---- runner plane: unknown sessions must not resolve --------------------
  const strayFiles = await fetch(`${base}/s/not-a-session/api/files`)
  check(
    'an unknown session cannot list files',
    strayFiles.status === 404,
    `${strayFiles.status}`
  )
} finally {
  daemon.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  daemon.kill('SIGKILL')
  await fs.rm(work, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
