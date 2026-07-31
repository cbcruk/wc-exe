// Host driver for the WebContainer shell probe.
//
// Serves the probe page cross-origin-isolated (WebContainer needs COOP/COEP),
// drives it in a headless Chromium, and prints what the runtime can actually
// do — plus writes the raw report to out/report.json.
//
// The question it answers: `docs/persistent-runner.md` sketches SSH-like access
// to a live container. WebContainer's spawn() advertises a pseudoterminal, but
// advertised is not measured. This runs it.
//
// Usage:
//   pnpm --dir poc/webcontainer-shell-probe install   # once
//   node poc/webcontainer-shell-probe/run.mjs [--headful] [--timeout 120000]
//
// Needs a Chrome/Chromium binary (CHROME_PATH, or the usual install paths) and
// outbound network access — WebContainer loads its runtime from StackBlitz.

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const rest = argv.slice(2)
  return {
    headful: rest.includes('--headful'),
    verbose: rest.includes('--verbose'),
    timeoutMs: Number(
      rest[rest.indexOf('--timeout') + 1] ??
        (rest.includes('--timeout') ? 0 : 180000)
    ),
  }
}

/**
 * Locates the installed `@webcontainer/api` so its `dist/` can be served
 * straight to the page. The package has no dependencies and only relative
 * imports, so no bundling step is needed.
 */
async function resolveWebContainerDist() {
  const entry = fileURLToPath(import.meta.resolve('@webcontainer/api'))
  const dist = path.dirname(entry)
  await fs.access(path.join(dist, 'index.js'))
  return dist
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('Chrome not found. Set CHROME_PATH.')
}

async function startServer(webcontainerDist) {
  const app = new Hono()

  // WebContainer requires cross-origin isolation, so every response carries it.
  app.use('*', async (c, next) => {
    await next()
    c.header('Cross-Origin-Embedder-Policy', 'require-corp')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
  })

  app.use(
    '/vendor/webcontainer/*',
    serveStatic({
      root: path.relative(process.cwd(), webcontainerDist),
      rewriteRequestPath: (p) => p.replace(/^\/vendor\/webcontainer/, ''),
    })
  )
  // Silences a 404 that would otherwise be the only error in a healthy run.
  app.get('/favicon.ico', (c) => c.body(null, 204))

  app.use(
    '/*',
    serveStatic({
      root: path.relative(process.cwd(), path.join(HERE, 'browser')),
    })
  )

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) =>
      resolve({ server, url: `http://localhost:${info.port}` })
    )
    server.on('error', reject)
  })
}

const ICON = {
  pass: '  OK  ',
  fail: ' FAIL ',
  error: 'ERROR ',
  skip: ' skip ',
  info: ' info ',
  broken: 'BROKEN',
}

function print(report) {
  console.log('\n=== WebContainer shell probe ===\n')

  for (const r of report.results ?? []) {
    const detail =
      r.detail.length > 400
        ? `${r.detail.slice(0, 400)}… (see report.json)`
        : r.detail
    console.log(`[${ICON[r.status] ?? r.status}] ${r.id}`)
    console.log(`         ${r.question}`)
    console.log(`         ${detail}\n`)
  }

  const broken = (report.results ?? []).filter((r) => r.status === 'broken')
  if (broken.length) {
    console.log(
      'A NEGATIVE CONTROL FIRED. The probe cannot tell present from absent here,\n' +
        'so treat every result above as unverified:\n' +
        broken.map((r) => `  - ${r.id}: ${r.detail}`).join('\n')
    )
    return
  }

  const counts = {}
  for (const r of report.results ?? [])
    counts[r.status] = (counts[r.status] ?? 0) + 1
  console.log(
    `summary: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`
  )
  if (report.fatal) {
    // Saying "no interactive shell was found" after an aborted boot would read
    // as a finding about WebContainer rather than about this run.
    console.log('the run aborted before the shell checks — nothing to conclude')
  } else {
    console.log(
      report.shell
        ? `interactive shell: ${report.shell}`
        : 'no interactive shell was found — an SSH-like session would have to be built on bare spawn()'
    )
  }
}

async function main() {
  const { headful, verbose, timeoutMs } = parseArgs(process.argv)

  const webcontainerDist = await resolveWebContainerDist()
  const { server, url } = await startServer(webcontainerDist)
  const browser = await puppeteer.launch({
    headless: !headful,
    executablePath: await findChrome(),
    protocolTimeout: timeoutMs + 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })

  try {
    const page = await browser.newPage()
    if (verbose) page.on('console', (m) => console.log('[page]', m.text()))
    page.on('pageerror', (err) => console.error('[page error]', err.message))
    // A missing module shows up as a bare 404 in the console with no URL, which
    // is nearly impossible to diagnose; name it here.
    page.on('response', (res) => {
      if (!res.ok()) console.error('[page HTTP]', res.status(), res.url())
      else if (verbose) console.log('[page HTTP]', res.status(), res.url())
    })

    await page.goto(url)
    await page.waitForFunction(() => window.__PROBE_DONE__ === true, {
      timeout: timeoutMs,
    })

    const report = await page.evaluate(() => window.__PROBE_RESULT__)

    const outDir = path.join(HERE, 'out')
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(
      path.join(outDir, 'report.json'),
      JSON.stringify(report, null, 2)
    )

    if (report.fatal) {
      console.error(`\nProbe aborted: ${report.fatal}`)
    }
    print(report)
    console.log(`\nraw report: ${path.join(outDir, 'report.json')}`)

    if (
      report.fatal ||
      (report.results ?? []).some((r) => r.status === 'broken')
    ) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    await new Promise((r) => server.close(() => r()))
  }
}

main().catch((err) => {
  console.error('\nProbe failed:', err.message)
  process.exit(1)
})
