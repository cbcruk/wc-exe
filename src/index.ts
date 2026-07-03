export { build } from './commands/build.js'
export { dev } from './commands/dev.js'
export { install } from './commands/install.js'

// Low-level primitives, exposed for programmatic use and benchmarking.
export { startServer, createApp, type ServerInfo } from './core/server.js'
export { WCBrowser } from './core/browser.js'
export { listProjectFiles, readProjectFileBytes } from './core/file-sync.js'

export type * from './types.js'
