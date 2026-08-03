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

/**
 * Nested directory listing used to mount a project into the runtime.
 * Keys are single path segments, not slash-separated paths.
 */
export interface FileSystemTree {
  [name: string]: FileSystemTreeNode
}

/** A single entry in a {@link FileSystemTree}. */
export type FileSystemTreeNode = FileNode | DirectoryNode

/** A file entry in a {@link FileSystemTree}. */
export interface FileNode {
  file: {
    contents: string | Uint8Array
  }
}

/** A directory entry in a {@link FileSystemTree}. */
export interface DirectoryNode {
  directory: FileSystemTree
}

/**
 * Message emitted by the in-browser runner while a command runs.
 */
export interface WCMessage {
  type: 'output' | 'error' | 'ready' | 'exit'
  /** Output or error text, for `output` / `error` messages. */
  data?: string
  /** Process exit code, for `exit` messages. */
  code?: number
}

/** Package managers the runtime can install with. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** Which package manager a project uses, and how that was decided. */
export interface PackageManagerChoice {
  manager: PackageManager
  /** Human-readable justification, so a wrong pick is visible in the log. */
  reason: string
  /** Executable to spawn — the manager, or `npx` when a version is pinned. */
  command: string
  /** Arguments that must precede the subcommand. */
  argsPrefix: string[]
  /** Why this invocation was chosen. */
  note: string
}

/** Terminal dimensions, in character cells. */
export interface TerminalSize {
  cols: number
  rows: number
}

/**
 * Result of running a command inside the runtime.
 *
 * Mirrors the runner's own `CommandResult`; kept here because the two sides are
 * built as separate bundles and cannot share a type import.
 */
export interface CommandResult {
  /** Exit code. A non-zero code is returned, not thrown. */
  exitCode: number
  /** Captured output, ANSI escapes intact. Possibly only the tail. */
  output: string
  /** Whether `output` is only the tail of what the command actually produced. */
  truncated: boolean
  /** Characters dropped from the front. `0` when nothing was lost. */
  droppedChars: number
}

/** Options for running a command inside the runtime. */
export interface RunCommandOptions {
  /**
   * Milliseconds before the command is killed and an error thrown. Omit to wait
   * indefinitely.
   */
  timeout?: number
  /** Working directory, relative to the runtime's working directory. */
  cwd?: string
  /** Extra environment variables for the command. */
  env?: Record<string, string | number | boolean>
  /** Size of the attached terminal. Commands read this as their tty width. */
  terminal?: TerminalSize
  /**
   * Caller-chosen id, so this command can be cancelled with `killCommand`.
   * One is generated automatically when a `timeout` is set.
   */
  handle?: string
}

/**
 * Result of one command run in an interactive shell.
 *
 * Mirrors the runner's own `ShellExecResult`; kept here because the two sides
 * are built as separate bundles and cannot share a type import.
 */
export interface ShellExecResult {
  /** Everything the command printed, ANSI escapes intact. */
  output: string
  /** The command's exit status, or `null` if the shell did not report one. */
  exitCode: number | null
}

/**
 * Outcome of a cache-aware install, as reported by the in-browser runner.
 *
 * Mirrors the runner's own `CacheResult`; kept here because the two sides are
 * built as separate bundles and cannot share a type import.
 */
export interface CacheResult {
  /** Whether `node_modules` was restored from a snapshot instead of installed. */
  cached: boolean
  /** Lockfile hash the snapshot is keyed on. */
  key: string
  /** Size of the snapshot just written. Absent on a cache HIT. */
  bytes?: number
  /** Whether npm's tarball cache was restored before installing. MISS only. */
  npmCacheRestored?: boolean
  /** Size of the tarball cache snapshot. MISS only. */
  npmCacheBytes?: number
  /** Which package manager performed the install. */
  manager?: PackageManager
}

/**
 * Host-side callbacks the local server exposes to the in-browser runner.
 * Each maps to one `/api` route in {@link createApp}.
 */
export interface ServerHandlers {
  /** Project-relative paths to mount, as returned by `GET /api/files`. */
  listFiles: () => Promise<string[]>
  /** Reads one project file, as returned by `GET /api/files/raw`. */
  readFile: (relPath: string) => Promise<Uint8Array>
  /**
   * Persists one build artifact, as accepted by `POST /api/dist`.
   * Omit to make the route respond `501` (e.g. in `dev`, which never uploads).
   */
  writeDistFile?: (relPath: string, data: Uint8Array) => Promise<void>
}
