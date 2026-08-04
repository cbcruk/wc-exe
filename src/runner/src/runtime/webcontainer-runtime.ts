import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import invariant from 'tiny-invariant'
import type {
  Runtime,
  SnapshotProvider,
  FileTree,
  RuntimeProcess,
  RuntimeDirEnt,
  SpawnOptions,
} from './runtime.types'

/**
 * {@link Runtime} backed by WebContainer.
 *
 * The single place WebContainer is referenced — everything WebContainer-specific
 * lives behind the {@link Runtime} / {@link SnapshotProvider} interfaces. Only
 * one instance can be booted per page, a WebContainer limitation.
 *
 * Every method other than {@link WebContainerRuntime.boot} throws until boot
 * has completed.
 */
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

  spawn(
    command: string,
    args: string[],
    options?: SpawnOptions
  ): Promise<RuntimeProcess> {
    // WebContainerProcess already is the full pseudoterminal shape the
    // RuntimeProcess interface describes, so this stays a passthrough.
    return this.wc.spawn(command, args, options)
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

  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    return this.wc.fs.rm(path, options)
  }

  get workdir(): string {
    return this.wc.workdir
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
