import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import invariant from 'tiny-invariant'
import type {
  Runtime,
  RuntimeFileSystem,
  SnapshotProvider,
  FileTree,
  RuntimeProcess,
  RuntimeDirEnt,
  SpawnOptions,
  Unsubscribe,
} from './runtime.types'

/**
 * {@link Runtime} backed by WebContainer.
 *
 * The single place WebContainer is referenced — everything WebContainer-specific
 * lives behind the {@link Runtime} / {@link SnapshotProvider} interfaces. Only
 * one instance can be booted per page, a WebContainer limitation.
 *
 * Because {@link Runtime} is shaped after WebContainer's own API, almost every
 * member here is a straight delegation. That is the point: an adapter with no
 * logic of its own cannot drift from the thing it adapts, and a replacement
 * backend is then implementing a contract rather than reverse-engineering one.
 *
 * Every member other than {@link WebContainerRuntime.boot} throws until boot
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

  /**
   * WebContainer's `fs` is nearly this interface already; the wrapper exists
   * for two members whose shapes differ, and passes the rest straight through.
   */
  get fs(): RuntimeFileSystem {
    const fs = this.wc.fs

    return {
      readFile: (path) => fs.readFile(path),
      writeFile: (path, data) => fs.writeFile(path, data),
      // Always with types: the interface does not offer the bare-names form.
      readdir: (path) =>
        fs.readdir(path, { withFileTypes: true }) as Promise<RuntimeDirEnt[]>,
      mkdir: async (path, options) => {
        // WebContainer splits recursive into a separate overload with a
        // different return type, so this branch is required rather than
        // passing options through.
        if (options?.recursive) {
          await fs.mkdir(path, { recursive: true })
        } else {
          await fs.mkdir(path)
        }
      },
      rm: (path, options) => fs.rm(path, options),
      rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    }
  }

  get workdir(): string {
    return this.wc.workdir
  }

  get path(): string {
    return this.wc.path
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

  onServerReady(listener: (port: number, url: string) => void): Unsubscribe {
    return this.wc.on('server-ready', listener)
  }

  teardown(): void {
    this.wc.teardown()
    this.webcontainer = null
  }

  exportDir(path: string): Promise<Uint8Array> {
    return this.wc.export(path, { format: 'binary' })
  }

  importSnapshot(snapshot: Uint8Array, mountPoint: string): Promise<void> {
    return this.wc.mount(snapshot, { mountPoint })
  }
}
