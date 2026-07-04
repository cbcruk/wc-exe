import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const CACHE_ROOT = process.env.WC_EXE_CACHE_DIR
  ? path.resolve(process.env.WC_EXE_CACHE_DIR)
  : path.join(os.homedir(), '.cache', 'wc-exe')

export const CHROME_PROFILE_DIR = path.join(CACHE_ROOT, 'chrome-profile')

// Fixed port so the runner page keeps a stable origin. OPFS is scoped per
// origin (scheme+host+port); a random port would orphan the cache every run.
export const CACHE_PORT = Number(process.env.WC_EXE_CACHE_PORT ?? 5199)

export function ensureCacheDirs(): void {
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true })
}
