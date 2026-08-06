import puppeteer, { type Browser } from 'puppeteer-core'
import { access } from 'node:fs/promises'

/** Well-known Chrome locations, checked when `CHROME_PATH` is not set. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/**
 * Resolves a Chrome executable: `CHROME_PATH` if set, otherwise the first hit
 * among the well-known install locations.
 */
export async function findChrome(): Promise<string> {
  const envPath = process.env.CHROME_PATH
  if (envPath) {
    try {
      await access(envPath)
      return envPath
    } catch {
      throw new Error(`CHROME_PATH is set but not accessible: ${envPath}`)
    }
  }

  for (const chromePath of CHROME_PATHS) {
    try {
      await access(chromePath)
      return chromePath
    } catch {
      continue
    }
  }

  throw new Error(
    'Chrome not found. Please install Chrome or set CHROME_PATH environment variable.'
  )
}

/**
 * Launches a headless Chrome.
 *
 * Lives here rather than inside {@link WCBrowser} because **a profile
 * directory can only back one Chrome process at a time.** Chrome enforces that
 * with a `SingletonLock` and refuses to start rather than risk corrupting the
 * profile, so anything wanting several pages against one persistent profile —
 * the daemon holding several projects open — has to share a single browser and
 * open pages on it, not launch one browser apiece.
 *
 * @param options.userDataDir Persistent profile. Required for OPFS (and so the
 *   `node_modules` cache) to survive; omit for a throwaway profile.
 */
export async function launchChrome(
  options: { userDataDir?: string } = {}
): Promise<Browser> {
  return await puppeteer.launch({
    headless: true,
    executablePath: await findChrome(),
    protocolTimeout: 600000,
    userDataDir: options.userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })
}
