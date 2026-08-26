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
 * Port the runner is served on when caching is enabled. Override with
 * `WC_EXE_CACHE_PORT`; defaults to `5199`.
 *
 * Fixed so the runner page keeps a stable origin: OPFS is scoped per origin
 * (scheme+host+port), so a random port would orphan the cache every run.
 *
 * This is now the *only* thing that determines whether the cache survives.
 * wc-exe used to also pass a dedicated Chrome profile directory it owned, which
 * made the cache ours to place. The page runs in the user's own browser now, so
 * the snapshot lives in that browser's storage for this origin — it persists
 * like any site's data, and it goes away if they clear site data or open the
 * page in a different browser.
 */
export const CACHE_PORT = Number(process.env.WC_EXE_CACHE_PORT ?? 5199)

/** Creates {@link CACHE_ROOT} if missing. */
export function ensureCacheDirs(): void {
  fs.mkdirSync(CACHE_ROOT, { recursive: true })
}
