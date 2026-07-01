export interface BuildOptions {
  source: string
  output: string
  distDir?: string
  noInstall?: boolean
  verbose?: boolean
  timeout?: number
}

export interface DevOptions {
  port: number
  open?: boolean
}

export interface InstallOptions {
  cache?: boolean
}

export interface FileSystemTree {
  [name: string]: FileSystemTreeNode
}

export type FileSystemTreeNode = FileNode | DirectoryNode

export interface FileNode {
  file: {
    contents: string | Uint8Array
  }
}

export interface DirectoryNode {
  directory: FileSystemTree
}

export interface WCMessage {
  type: 'output' | 'error' | 'ready' | 'exit'
  data?: string
  code?: number
}

export interface ServerHandlers {
  listFiles: () => Promise<string[]>
  readFile: (relPath: string) => Promise<Uint8Array>
  writeDistFile?: (relPath: string, data: Uint8Array) => Promise<void>
}
