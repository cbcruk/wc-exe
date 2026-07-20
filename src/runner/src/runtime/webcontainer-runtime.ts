import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import invariant from 'tiny-invariant'
import type {
  Runtime,
  SnapshotProvider,
  FileTree,
  RuntimeProcess,
  RuntimeDirEnt,
} from './runtime.types'

// The single place WebContainer is referenced. Everything WebContainer-specific
// lives behind the Runtime / SnapshotProvider interfaces.
export class WebContainerRuntime implements Runtime, SnapshotProvider {
  private webcontainer: WebContainer | null = null

  private get wc(): WebContainer {
    invariant(this.webcontainer, 'WebContainer not booted')
    return this.webcontainer
  }

  async boot(): Promise<void> {
    this.webcontainer = await WebContainer.boot()
  }

  mount(tree: FileTree, options?: { mountPoint?: string }): Promise<void> {
    return this.wc.mount(tree as FileSystemTree, options)
  }

  spawn(command: string, args: string[]): Promise<RuntimeProcess> {
    return this.wc.spawn(command, args)
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.wc.fs.readFile(path)
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.wc.fs.writeFile(path, data)
  }

  readdir(path: string): Promise<RuntimeDirEnt[]> {
    return this.wc.fs.readdir(path, { withFileTypes: true })
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // WebContainer splits recursive into a separate overload with a different
    // return type, so the branch is required rather than passing options through.
    if (options?.recursive) {
      await this.wc.fs.mkdir(path, { recursive: true })
    } else {
      await this.wc.fs.mkdir(path)
    }
  }

  onServerReady(listener: (port: number, url: string) => void): void {
    this.wc.on('server-ready', listener)
  }

  exportDir(path: string): Promise<Uint8Array> {
    return this.wc.export(path, { format: 'binary' })
  }

  importSnapshot(snapshot: Uint8Array, mountPoint: string): Promise<void> {
    return this.wc.mount(snapshot, { mountPoint })
  }
}
