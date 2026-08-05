// Backend-agnostic runtime surface the runner logic is written against.
// The only place that may reference WebContainer directly is the implementing
// class (webcontainer-runtime.ts). Adding another backend means implementing
// this interface, not touching the runner logic.
//
// The shape deliberately mirrors WebContainer's own API — `fs` as a namespace,
// `spawn`, `workdir`, `path`, `teardown`. Two reasons:
//
//   1. It is the contract a replacement backend has to satisfy, and a shape
//      somebody already knows is far easier to satisfy than one invented here.
//   2. It keeps WebContainerRuntime an almost pure pass-through, so the adapter
//      cannot quietly acquire behaviour of its own and become the thing that
//      actually has to be reimplemented.
//
// Where it deviates, the deviation is noted at the member.

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

/** Terminal dimensions, in character cells. */
export interface TerminalSize {
  cols: number
  rows: number
}

/** Options accepted by {@link Runtime.spawn}. */
export interface SpawnOptions {
  /** Working directory, relative to the runtime's own working directory. */
  cwd?: string
  /** Environment variables to set for the process. */
  env?: Record<string, string | number | boolean>
  /** Set `false` to suppress the output stream entirely. */
  output?: boolean
  /** Size of the attached terminal. Processes read this as their tty width. */
  terminal?: TerminalSize
}

/**
 * A process started by {@link Runtime.spawn}.
 *
 * Deliberately mirrors a pseudoterminal rather than a plain pipe: the backend
 * attaches one, and collapsing it to just an exit code — which this interface
 * used to do — throws away cancellation, interactive input and terminal sizing.
 */
export interface RuntimeProcess {
  /** Merged stdout/stderr, still carrying ANSI escapes. */
  output: ReadableStream<string>
  /**
   * Input side of the attached terminal. Writing a line runs it; writing a
   * control byte such as `\x03` interrupts, exactly as typing would.
   */
  input: WritableStream<string>
  /** Resolves with the exit code. A non-zero code resolves, it does not reject. */
  exit: Promise<number>
  /** Terminates the process. {@link exit} then resolves with the signal code. */
  kill(): void
  /** Tells the process its terminal was resized. */
  resize(dimensions: TerminalSize): void
}

/** A directory entry returned by {@link RuntimeFileSystem.readdir}. */
export interface RuntimeDirEnt {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

/**
 * The filesystem of a booted runtime.
 *
 * **Paths are resolved against {@link Runtime.workdir}, including ones that
 * look absolute.** `readFile('/bin/ls')` reads `<workdir>/bin/ls`, not the
 * system path — measured, and the cause of a whole afternoon once. Reaching
 * outside the project means going through the shell.
 */
export interface RuntimeFileSystem {
  /** Reads a file as raw bytes. Rejects if it does not exist. */
  readFile(path: string): Promise<Uint8Array>
  /** Writes a file, overwriting any existing contents. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  /**
   * Lists a directory's entries.
   *
   * Deviation: always returns entries with type information. WebContainer
   * overloads this to return bare names without `withFileTypes`, and nothing
   * here wants the weaker form.
   */
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
  /** Moves a path. */
  rename(oldPath: string, newPath: string): Promise<void>
}

/** Cancels a listener registered with {@link Runtime.onServerReady}. */
export type Unsubscribe = () => void

/**
 * The execution backend the runner drives.
 *
 * Implement this to add a backend; nothing outside the implementing class
 * should know which one is in use. {@link boot} must complete before any other
 * member is touched.
 */
export interface Runtime {
  /** Boots the backend. Call once, before anything else. */
  boot(): Promise<void>
  /** The filesystem. See {@link RuntimeFileSystem} for how paths resolve. */
  readonly fs: RuntimeFileSystem
  /** Absolute path of the working directory processes start in. */
  readonly workdir: string
  /**
   * Default `PATH` for spawned processes.
   *
   * Worth having because it is the only way to discover what a backend can
   * actually run: the filesystem cannot see the directories on it (see
   * {@link RuntimeFileSystem}), so the answer has to come from here or from
   * the shell.
   */
  readonly path: string
  /**
   * Writes a file tree into the filesystem.
   *
   * @param tree Files to write, as nested segments.
   * @param options.mountPoint Root-relative directory to mount under. Defaults
   *   to the working directory.
   */
  mount(tree: FileTree, options?: { mountPoint?: string }): Promise<void>
  /** Starts a process. Resolves once spawned, not once exited. */
  spawn(
    command: string,
    args: string[],
    options?: SpawnOptions
  ): Promise<RuntimeProcess>
  /**
   * Registers a listener fired when a process inside the runtime starts
   * listening on a port. `url` is the address reachable from the host page.
   *
   * Deviation: WebContainer exposes a general `on(event, …)` covering several
   * events. Only this one is used, and narrowing it keeps the contract a
   * backend must satisfy small.
   */
  onServerReady(listener: (port: number, url: string) => void): Unsubscribe
  /**
   * Destroys the runtime and releases its resources.
   *
   * The reset of last resort: `docs/persistent-runner.md` §6 lists cases where
   * a session cannot be trusted and has to be rebuilt rather than cleaned.
   */
  teardown(): void
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
