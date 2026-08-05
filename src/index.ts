/**
 * Public API of wc-exe.
 *
 * Two layers, deliberately separate:
 *
 * - **The bridge** (`./core`) — driving a WebContainer from Node. Serve a
 *   project to a page, boot a runtime, run commands with a real pseudoterminal,
 *   copy artifacts back. Independent of this CLI and of any terminal.
 * - **The commands** — `build`, `dev`, `install`, which are one consumer of the
 *   bridge and the shape the CLI happens to take. Note they call `process.exit`
 *   on success, so anything embedding wc-exe wants the bridge instead.
 *
 * @module
 */

export { build } from './commands/build.js'
export { dev } from './commands/dev.js'
export { install } from './commands/install.js'

export * from './core/index.js'

export type * from './types.js'
