// Backend-agnostic runtime surface the runner logic is written against.
// The only place that may reference WebContainer directly is the implementing
// class (webcontainer-runtime.ts). Adding another backend (e.g. container2wasm)
// means implementing this interface, not touching the runner logic.

export interface FileNode {
  file: { contents: string | Uint8Array }
}

export interface DirectoryNode {
  directory: FileTree
}

export interface FileTree {
  [name: string]: FileNode | DirectoryNode
}

export interface RuntimeProcess {
  output: ReadableStream<string>
  exit: Promise<number>
}

export interface RuntimeDirEnt {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

export interface Runtime {
  boot(): Promise<void>
  mount(tree: FileTree, options?: { mountPoint?: string }): Promise<void>
  spawn(command: string, args: string[]): Promise<RuntimeProcess>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  readdir(path: string): Promise<RuntimeDirEnt[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  onServerReady(listener: (port: number, url: string) => void): void
}

// Snapshotting a directory to a portable blob and re-mounting it is a
// backend-specific capability (WebContainer's binary export). Backends without
// it simply don't implement this, and the node_modules cache degrades to a
// plain install — see isSnapshotCapable.
export interface SnapshotProvider {
  exportDir(path: string): Promise<Uint8Array>
  importSnapshot(snapshot: Uint8Array, mountPoint: string): Promise<void>
}

export function isSnapshotCapable(
  runtime: Runtime
): runtime is Runtime & SnapshotProvider {
  const candidate = runtime as Partial<SnapshotProvider>
  return (
    typeof candidate.exportDir === 'function' &&
    typeof candidate.importSnapshot === 'function'
  )
}
