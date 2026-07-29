import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Root of the on-disk cache. Override with `WC_EXE_CACHE_DIR`; defaults to
 * `~/.cache/wc-exe`.
 */
export const CACHE_ROOT = process.env.WC_EXE_CACHE_DIR
  ? path.resolve(process.env.WC_EXE_CACHE_DIR)
  : path.join(os.homedir(), '.cache', 'wc-exe')

/**
 * Persistent Chrome profile directory. Passing it to the browser is what keeps
 * OPFS — and with it the `node_modules` cache — alive between runs.
 */
export const CHROME_PROFILE_DIR = path.join(CACHE_ROOT, 'chrome-profile')

/**
 * Port the runner is served on when caching is enabled. Override with
 * `WC_EXE_CACHE_PORT`; defaults to `5199`.
 *
 * Fixed so the runner page keeps a stable origin: OPFS is scoped per origin
 * (scheme+host+port), so a random port would orphan the cache every run.
 */
export const CACHE_PORT = Number(process.env.WC_EXE_CACHE_PORT ?? 5199)

/**
 * Creates the cache directories if missing. Call before launching a browser
 * with {@link CHROME_PROFILE_DIR}.
 */
export function ensureCacheDirs(): void {
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true })
}
