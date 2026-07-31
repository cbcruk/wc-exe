// Backend-agnostic runtime surface the runner logic is written against.
// The only place that may reference WebContainer directly is the implementing
// class (webcontainer-runtime.ts). Adding another backend (e.g. container2wasm)
// means implementing this interface, not touching the runner logic.

/** A file entry in a {@link FileTree}. */
export interface FileNode {
  file: { contents: string | Uint8Array }
}

/** A directory entry in a {@link FileTree}. */
export interface DirectoryNode {
  directory: FileTree
}

/**
 * Nested directory listing passed to {@link Runtime.mount}. Keys are single
 * path segments, not slash-separated paths.
 */
export interface FileTree {
  [name: string]: FileNode | DirectoryNode
}

/** A process started by {@link Runtime.spawn}. */
export interface RuntimeProcess {
  /** Merged stdout/stderr, still carrying ANSI escapes. */
  output: ReadableStream<string>
  /** Resolves with the exit code. A non-zero code resolves, it does not reject. */
  exit: Promise<number>
}

/** A directory entry returned by {@link Runtime.readdir}. */
export interface RuntimeDirEnt {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

/**
 * The execution backend the runner drives.
 *
 * Implement this to add a backend; nothing outside the implementing class
 * should know which one is in use. {@link boot} must complete before any other
 * method is called.
 */
export interface Runtime {
  /** Boots the backend. Call once, before anything else. */
  boot(): Promise<void>
  /**
   * Writes a file tree into the filesystem.
   *
   * @param tree Files to write, as nested segments.
   * @param options.mountPoint Root-relative directory to mount under. Defaults
   *   to the filesystem root.
   */
  mount(tree: FileTree, options?: { mountPoint?: string }): Promise<void>
  /** Starts a process. Resolves once spawned, not once exited. */
  spawn(command: string, args: string[]): Promise<RuntimeProcess>
  /** Reads a file as raw bytes. Rejects if it does not exist. */
  readFile(path: string): Promise<Uint8Array>
  /** Writes a file, overwriting any existing contents. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  /** Lists a directory's entries. */
  readdir(path: string): Promise<RuntimeDirEnt[]>
  /**
   * Creates a directory.
   *
   * @param options.recursive Create missing parents, and succeed if the
   *   directory already exists.
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  /**
   * Deletes a path.
   *
   * Needed because {@link Runtime.mount} only adds and overwrites: a file
   * deleted on the host would otherwise survive in the runtime and stay
   * resolvable by the build.
   *
   * @param options.recursive Delete directories and their contents.
   * @param options.force Succeed if the path does not exist.
   */
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>
  /**
   * Registers a listener fired when a process inside the runtime starts
   * listening on a port. `url` is the address reachable from the host page.
   */
  onServerReady(listener: (port: number, url: string) => void): void
}

// Snapshotting a directory to a portable blob and re-mounting it is a
// backend-specific capability (WebContainer's binary export). Backends without
// it simply don't implement this, and the node_modules cache degrades to a
// plain install — see isSnapshotCapable.
export interface SnapshotProvider {
  /**
   * Serializes a directory to a portable blob.
   *
   * @param path Directory to snapshot, root-relative.
   */
  exportDir(path: string): Promise<Uint8Array>
  /**
   * Restores a blob produced by {@link SnapshotProvider.exportDir}.
   *
   * @param snapshot Blob to restore.
   * @param mountPoint Root-relative directory to restore it under.
   */
  importSnapshot(snapshot: Uint8Array, mountPoint: string): Promise<void>
}

/**
 * Narrows a {@link Runtime} to one that can snapshot directories, by checking
 * for the methods at runtime rather than by tagging the class.
 *
 * Callers use this to fall back to a plain install on backends without
 * snapshot support, instead of failing.
 */
export function isSnapshotCapable(
  runtime: Runtime
): runtime is Runtime & SnapshotProvider {
  const candidate = runtime as Partial<SnapshotProvider>
  return (
    typeof candidate.exportDir === 'function' &&
    typeof candidate.importSnapshot === 'function'
  )
}
