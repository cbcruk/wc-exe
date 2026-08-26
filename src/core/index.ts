/**
 * The bridge: driving a WebContainer from Node.
 *
 * This is the durable half of wc-exe. It knows how to serve a project to a
 * page, boot a runtime in a browser tab, run commands with a real
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

export { RunnerClient } from './runner-client.js'
export {
  runProjectBuild,
  type BuildRunner,
  type BuildStep,
  type BuildProgress,
  type ProjectBuildOptions,
  type ProjectBuildResult,
} from './project-build.js'
export { RunnerLink, mountRpcRoutes } from './rpc.js'
export { openInBrowser } from './open.js'
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
export { CACHE_ROOT, CACHE_PORT, ensureCacheDirs } from './cache.js'
export { resolveRunnerDist } from './runner-assets.js'
export { commandFailure, outputTail } from './command-error.js'

export type * from './types.js'
