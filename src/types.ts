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
