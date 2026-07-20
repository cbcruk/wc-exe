import invariant from 'tiny-invariant'
import { WebContainerRuntime } from './runtime/webcontainer-runtime'
import {
  isSnapshotCapable,
  type FileTree,
  type Runtime,
  type SnapshotProvider,
} from './runtime/runtime.types'

const ANSI_REGEX =
  /* eslint-disable-next-line no-control-regex */
  /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const SPINNER_CHARS = [
  '\\',
  '|',
  '/',
  '-',
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]

function filterOutput(chunk: string): string | null {
  const cleaned = chunk.replace(ANSI_REGEX, '').trim()

  if (!cleaned) return null

  if (SPINNER_CHARS.includes(cleaned)) return null

  return chunk
}

declare global {
  interface Window {
    __WC_READY__: boolean
    wcRunner: typeof wcRunner
  }
}

let runtime: Runtime | null = null

async function boot(): Promise<void> {
  console.log('[wc-build] Booting runtime...')
  const instance = new WebContainerRuntime()
  await instance.boot()
  runtime = instance
  console.log('[wc-build] Runtime ready!')
  window.__WC_READY__ = true
}

async function mountFromServer(): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  const manifestRes = await fetch('/api/files')
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch file manifest: ${manifestRes.status}`)
  }

  const paths: string[] = await manifestRes.json()

  console.log(`[wc-build] Fetching ${paths.length} files...`)

  const tree: FileTree = {}

  for (const filePath of paths) {
    const fileRes = await fetch(
      `/api/files/raw?path=${encodeURIComponent(filePath)}`
    )
    if (!fileRes.ok) {
      throw new Error(`Failed to fetch file ${filePath}: ${fileRes.status}`)
    }

    const contents = new Uint8Array(await fileRes.arrayBuffer())
    insertIntoTree(tree, filePath, contents)
  }

  await runtime.mount(tree)

  console.log(`[wc-build] Mounted ${paths.length} files.`)

  return paths.length
}

function insertIntoTree(
  tree: FileTree,
  filePath: string,
  contents: Uint8Array
): void {
  const parts = filePath.split('/').filter(Boolean)
  let node = tree

  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i]
    const existing = node[dir]

    if (!existing) {
      const child: FileTree = {}
      node[dir] = { directory: child }
      node = child
    } else if ('directory' in existing) {
      node = existing.directory
    } else {
      throw new Error(`Path conflict: ${dir} is a file, expected a directory`)
    }
  }

  node[parts[parts.length - 1]] = { file: { contents } }
}

async function runCommand(cmd: string, args: string[]): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  console.log(`[wc-build] Running: ${cmd} ${args.join(' ')}`)

  const process = await runtime.spawn(cmd, args)

  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        const filtered = filterOutput(chunk)
        if (filtered) console.log(filtered)
      },
    })
  )

  const exitCode = await process.exit

  if (exitCode === 0) {
    console.log(`[wc-build] Command exited with code: ${exitCode}`)
  } else {
    console.error(`[wc-build] Command exited with code: ${exitCode}`)
  }

  return exitCode
}

type CacheResult = {
  cached: boolean
  key: string
  bytes?: number
  // Tarball-level cache (npm's own content-addressed cacache) stats, present
  // on a node_modules MISS when the tarball cache participated.
  npmCacheRestored?: boolean
  npmCacheBytes?: number
}

const LOCK_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package.json',
]

// The npm tarball cache (cacache) lives at a fixed path inside the runtime so
// we can snapshot it to OPFS and restore it before an install. Unlike the
// node_modules snapshot (keyed by lockfile hash), this is a SINGLE global blob
// that accumulates tarballs across lockfile versions — so when the lockfile
// changes, only the newly-added packages hit the network; everything unchanged
// replays from cache. This is the WebContainer-real-npm equivalent of burrow's
// offline lockfile replay (see docs/virtual-filesystem.md §8).
const NPM_CACHE_MOUNT = '.npm-cache' // mount point (root-relative)
const NPM_CACHE_DIR = '/.npm-cache' // absolute path passed to `npm --cache`
const NPM_CACHE_OPFS = 'npm-cacache.bin' // single global OPFS blob

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function computeCacheKey(): Promise<string> {
  invariant(runtime, 'Runtime not booted')

  for (const file of LOCK_FILES) {
    try {
      const contents = await runtime.readFile(file)
      return (await sha256Hex(contents)).slice(0, 32)
    } catch {
      continue
    }
  }

  throw new Error('No lockfile or package.json found to key the cache on')
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function restoreNodeModules(
  provider: SnapshotProvider,
  key: string
): Promise<boolean> {
  const root = await opfsRoot()
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(`nm-${key}.bin`)
  } catch {
    return false
  }

  const file = await handle.getFile()
  const snapshot = new Uint8Array(await file.arrayBuffer())
  await provider.importSnapshot(snapshot, 'node_modules')

  return true
}

async function saveNodeModules(
  provider: SnapshotProvider,
  key: string
): Promise<number> {
  const snapshot = await provider.exportDir('node_modules')

  const root = await opfsRoot()
  const handle = await root.getFileHandle(`nm-${key}.bin`, { create: true })
  const writable = await handle.createWritable()
  await writable.write(snapshot as FileSystemWriteChunkType)
  await writable.close()

  return snapshot.byteLength
}

// Restore the global npm tarball cache (cacache) from OPFS into the runtime, so
// the upcoming install can replay unchanged packages offline. Best-effort:
// returns false (and installs online) if there is no cache yet.
async function restoreNpmCache(provider: SnapshotProvider): Promise<boolean> {
  const root = await opfsRoot()
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(NPM_CACHE_OPFS)
  } catch {
    return false
  }

  const file = await handle.getFile()
  const snapshot = new Uint8Array(await file.arrayBuffer())
  await provider.importSnapshot(snapshot, NPM_CACHE_MOUNT)

  return true
}

// Persist the (now-updated) npm tarball cache back to OPFS as a single global
// blob. Grows over time as new packages are seen; that's the storage cost of
// offline replay.
async function saveNpmCache(provider: SnapshotProvider): Promise<number> {
  const snapshot = await provider.exportDir(NPM_CACHE_MOUNT)

  const root = await opfsRoot()
  const handle = await root.getFileHandle(NPM_CACHE_OPFS, { create: true })
  const writable = await handle.createWritable()
  await writable.write(snapshot as FileSystemWriteChunkType)
  await writable.close()

  return snapshot.byteLength
}

async function installWithCache(): Promise<CacheResult> {
  invariant(runtime, 'Runtime not booted')

  const key = await computeCacheKey()

  // The cache needs a snapshot-capable backend; otherwise fall back to a plain
  // install so a future backend without export/import still works.
  if (!isSnapshotCapable(runtime)) {
    console.log(
      '[wc-build] Runtime has no snapshot support; installing plainly'
    )
    const code = await runCommand('npm', ['install'])
    if (code !== 0) {
      throw new Error(`npm install failed with exit code ${code}`)
    }
    return { cached: false, key }
  }

  if (await restoreNodeModules(runtime, key)) {
    console.log(`[wc-build] node_modules cache HIT (${key.slice(0, 12)})`)
    return { cached: true, key }
  }

  console.log(`[wc-build] node_modules cache MISS (${key.slice(0, 12)})`)

  // Even on a full node_modules miss, prime npm's own content-addressed tarball
  // cache from OPFS so only packages new to *this* lockfile hit the network.
  const npmCacheRestored = await restoreNpmCache(runtime)
  console.log(
    npmCacheRestored
      ? '[wc-build] npm tarball cache restored; installing --prefer-offline'
      : '[wc-build] no npm tarball cache yet; installing online (will seed it)'
  )

  const code = await runCommand('npm', [
    'install',
    '--prefer-offline',
    '--cache',
    NPM_CACHE_DIR,
  ])
  if (code !== 0) {
    throw new Error(`npm install failed with exit code ${code}`)
  }

  const bytes = await saveNodeModules(runtime, key)
  console.log(
    `[wc-build] Cached node_modules snapshot: ${(bytes / 1048576).toFixed(1)} MB`
  )

  const npmCacheBytes = await saveNpmCache(runtime)
  console.log(
    `[wc-build] Updated npm tarball cache: ${(npmCacheBytes / 1048576).toFixed(1)} MB`
  )

  return { cached: false, key, bytes, npmCacheRestored, npmCacheBytes }
}

function spawnCommand(cmd: string, args: string[]): void {
  invariant(runtime, 'Runtime not booted')

  console.log(`[wc-build] Spawning: ${cmd} ${args.join(' ')}`)

  runtime.spawn(cmd, args).then((process) => {
    process.output.pipeTo(
      new WritableStream({
        write(chunk) {
          const filtered = filterOutput(chunk)
          if (filtered) console.log(filtered)
        },
      })
    )
  })
}

async function writeFile(path: string, content: string): Promise<void> {
  invariant(runtime, 'Runtime not booted')

  await runtime.writeFile(path, content)

  console.log(`[wc-build] File written: ${path}`)
}

async function uploadDist(distPath: string): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  const rt = runtime
  let count = 0

  async function traverse(currentPath: string): Promise<void> {
    const entries = await rt.readdir(currentPath)

    for (const entry of entries) {
      const fullPath =
        currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`

      if (entry.isDirectory()) {
        await traverse(fullPath)
      } else {
        const content = await rt.readFile(fullPath)
        const relative = fullPath.slice(distPath.length).replace(/^\//, '')
        const body = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength
        ) as ArrayBuffer

        const res = await fetch(
          `/api/dist?path=${encodeURIComponent(relative)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          }
        )

        if (!res.ok) {
          throw new Error(`Failed to upload ${relative}: ${res.status}`)
        }

        count++
      }
    }
  }

  await traverse(distPath)

  console.log(`[wc-build] Uploaded ${count} dist files.`)

  return count
}

async function getServerUrl(): Promise<{ port: number; url: string }> {
  invariant(runtime, 'Runtime not booted')

  const rt = runtime

  return new Promise((resolve) => {
    let resolved = false

    rt.onServerReady((port, url) => {
      if (resolved) return
      resolved = true
      console.log(`[wc-build] Server ready at ${url}`)
      resolve({ port, url })
    })
  })
}

const wcRunner = {
  boot,
  mountFromServer,
  runCommand,
  installWithCache,
  spawnCommand,
  writeFile,
  uploadDist,
  getServerUrl,
}

window.wcRunner = wcRunner

boot().catch((err) => {
  console.error(`[wc-build] Boot failed: ${err.message}`)
})
