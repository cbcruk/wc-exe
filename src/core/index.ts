/**
 * The bridge: driving a WebContainer from Node.
 *
 * This is the durable half of wc-exe. It knows how to serve a project to a
 * page, boot a runtime in headless Chrome, run commands with a real
 * pseudoterminal, keep an interactive shell, and copy artifacts back out. None
 * of that is specific to the `wc-exe` CLI, and none of it assumes a terminal —
 * the CLI, the daemon and the benchmarks are all just consumers.
 *
 * **This module must not depend on the CLI.** No argument parsing, no spinners,
 * no colours, no file watching. `boundary.test.ts` enforces that rather than
 * trusting it to be remembered: a boundary nothing checks stops being one.
 *
 * @module
 */

export { WCBrowser } from './browser.js'
export { findChrome, launchChrome } from './chrome.js'
export {
  startServer,
  startServerWithFallback,
  createApp,
  type ServerInfo,
} from './server.js'
export {
  listProjectFiles,
  readProjectFileBytes,
  listProjectManifest,
  diffManifests,
  prepareOutputDir,
  writeDistFile,
  type Manifest,
  type SyncPlan,
} from './file-sync.js'
export {
  CACHE_ROOT,
  CACHE_PORT,
  CHROME_PROFILE_DIR,
  ensureCacheDirs,
} from './cache.js'
export { resolveRunnerDist } from './runner-assets.js'
export { commandFailure, outputTail } from './command-error.js'

export type * from './types.js'
