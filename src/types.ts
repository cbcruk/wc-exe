/**
 * Options for the CLI commands.
 *
 * The bridge's own types live in `core/types.ts`; these describe how the CLI
 * is invoked and mean nothing to a library consumer.
 */

/**
 * Options for {@link build}.
 */
export interface BuildOptions {
  /** Host directory mounted into the runtime. Defaults to `.`. */
  source: string
  /** Host directory the built output is written to. Defaults to `./dist`. */
  output: string
  /** Build output path *inside* the runtime. Defaults to `/dist`. */
  distDir?: string
  /** Skip the dependency install step and build against existing `node_modules`. */
  noInstall?: boolean
  /** Reuse an OPFS-cached `node_modules` when the lockfile is unchanged. */
  cache?: boolean
  /** Forward browser console output to the terminal. */
  verbose?: boolean
  /** Per-command timeout in milliseconds. Omit to wait indefinitely. */
  timeout?: number
}

/**
 * Options for {@link dev}.
 */
export interface DevOptions {
  /** Local port the dev server is proxied to. Defaults to `5173`. */
  port: number
  /** Reserved: open the proxied URL in a browser once ready. */
  open?: boolean
}

/**
 * Options for {@link install}.
 */
export interface InstallOptions {
  /** Reuse an OPFS-cached `node_modules` when the lockfile is unchanged. */
  cache?: boolean
}
