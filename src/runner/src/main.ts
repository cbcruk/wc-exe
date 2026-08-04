import invariant from 'tiny-invariant'
import { WebContainerRuntime } from './runtime/webcontainer-runtime'
import {
  isSnapshotCapable,
  type FileTree,
  type Runtime,
  type RuntimeProcess,
  type SnapshotProvider,
  type SpawnOptions,
  type TerminalSize,
} from './runtime/runtime.types'
import { OutputBuffer } from './runtime/output-buffer'
import {
  detectPackageManager,
  installArgs,
  offlineInstallArgs,
  usesNpmTarballCache,
  LOCKFILES,
  packageManagerCommand,
  parsePackageManagerVersion,
  type PackageManager,
  type PackageManagerChoice,
  type PackageManagerCommand,
} from './runtime/package-manager'
import { ShellSession, type ShellExecResult } from './runtime/shell-session'

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

/**
 * Drops noise from a process output chunk so the host log stays readable.
 *
 * @returns The chunk unchanged (escapes and all), or `null` if it was blank or
 *   a lone spinner frame.
 */
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
    /** Installed by the host via `page.exposeFunction`; see {@link openShell}. */
    __wcShellData__?: (id: string, chunk: string) => void
  }
}

/**
 * Base the `/api` routes hang off, taken from where this page was served.
 *
 * The one-shot server mounts the page at `/`; the daemon mounts one session per
 * path. Resolving against the page's own directory makes the same bundle work
 * for both, so the runner never needs to know which it is talking to.
 */
const API_BASE = new URL('.', location.href)

/** Absolute URL for an API route, e.g. `apiUrl('api/files')`. */
function apiUrl(path: string): string {
  return new URL(path, API_BASE).href
}

let runtime: Runtime | null = null

/**
 * Boots the runtime and flags the page ready. Runs automatically on load; the
 * host waits on `window.__WC_READY__` before calling anything else.
 */
async function boot(): Promise<void> {
  console.log('[wc-build] Booting runtime...')
  const instance = new WebContainerRuntime()
  await instance.boot()
  runtime = instance
  console.log('[wc-build] Runtime ready!')
  window.__WC_READY__ = true
}

/**
 * Fetches the project from the host server and mounts it into the runtime.
 *
 * Files are fetched one at a time and assembled into a single tree, then
 * mounted in one call.
 *
 * @returns Number of files mounted.
 * @throws If the manifest or any file fails to fetch.
 */
async function mountFromServer(): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  const manifestRes = await fetch(apiUrl('api/files'))
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch file manifest: ${manifestRes.status}`)
  }

  const paths: string[] = await manifestRes.json()

  console.log(`[wc-build] Fetching ${paths.length} files...`)

  const tree: FileTree = {}

  for (const filePath of paths) {
    const fileRes = await fetch(
      apiUrl(`api/files/raw?path=${encodeURIComponent(filePath)}`)
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

/**
 * Inserts a file into a {@link FileTree}, creating intermediate directories.
 *
 * @param filePath Slash-separated path relative to the tree root.
 * @throws If a path segment is already occupied by a file.
 */
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

/**
 * How much command output is retained for the host. Beyond this the oldest
 * characters are dropped and the result says so — see {@link OutputBuffer}.
 */
const OUTPUT_LIMIT = 256 * 1024

/**
 * Commands currently running, by the handle the caller supplied.
 *
 * Needed because {@link runCommand} does not resolve until the command exits,
 * so a caller can never learn a handle it did not choose itself. The caller
 * names the command up front and can then cancel it mid-flight.
 */
const running = new Map<string, RuntimeProcess>()

/** Outcome of {@link runCommand}. */
type CommandResult = {
  /** Exit code. Non-zero is returned, not thrown. */
  exitCode: number
  /** Captured output, ANSI escapes intact. Possibly only the tail. */
  output: string
  /** Whether `output` is only the tail of what the command actually produced. */
  truncated: boolean
  /** Characters dropped from the front. `0` when nothing was lost. */
  droppedChars: number
}

/**
 * Runs a command to completion, streaming its output to the page console (where
 * the host picks it up in verbose mode) and capturing it for the caller.
 *
 * @param handle Optional caller-chosen id. Pass one to be able to
 *   {@link killCommand} this command while it runs.
 * @returns The exit code and the captured output.
 */
async function runCommand(
  cmd: string,
  args: string[],
  options?: SpawnOptions & { handle?: string }
): Promise<CommandResult> {
  invariant(runtime, 'Runtime not booted')

  console.log(`[wc-build] Running: ${cmd} ${args.join(' ')}`)

  const { handle, ...spawnOptions } = options ?? {}
  const process = await runtime.spawn(cmd, args, spawnOptions)
  const buffer = new OutputBuffer(OUTPUT_LIMIT)

  if (handle) running.set(handle, process)

  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        buffer.push(chunk)
        const filtered = filterOutput(chunk)
        if (filtered) console.log(filtered)
      },
    })
  )

  try {
    const exitCode = await process.exit

    if (exitCode === 0) {
      console.log(`[wc-build] Command exited with code: ${exitCode}`)
    } else {
      console.error(`[wc-build] Command exited with code: ${exitCode}`)
    }

    return {
      exitCode,
      output: buffer.text,
      truncated: buffer.truncated,
      droppedChars: buffer.droppedChars,
    }
  } finally {
    if (handle) running.delete(handle)
  }
}

/**
 * Terminates a command started with a `handle`.
 *
 * @returns `true` if a running command matched, `false` if it had already
 *   exited or the handle was never used. A miss is not an error — the race
 *   between cancelling and finishing is normal.
 */
function killCommand(handle: string): boolean {
  const process = running.get(handle)
  if (!process) return false

  process.kill()
  return true
}

/**
 * Tells a running command its terminal was resized.
 *
 * @returns `true` if a running command matched, `false` otherwise.
 */
function resizeCommand(handle: string, dimensions: TerminalSize): boolean {
  const process = running.get(handle)
  if (!process) return false

  process.resize(dimensions)
  return true
}

/**
 * Open interactive shells, by caller-chosen id.
 *
 * Kept per session rather than one global shell because the daemon will hold
 * several projects open at once, and because a broken shell (see
 * {@link ShellSession}) has to be discardable without disturbing the others.
 */
const shells = new Map<string, ShellSession>()

/**
 * Opens an interactive shell.
 *
 * Output is pushed to `window.__wcShellData__` as it arrives — the host
 * installs that via `page.exposeFunction`, so a terminal stays responsive
 * instead of waiting on a poll interval.
 *
 * @throws If `id` is already in use.
 */
async function openShell(
  id: string,
  options?: { cols?: number; rows?: number }
): Promise<void> {
  invariant(runtime, 'Runtime not booted')
  invariant(!shells.has(id), `Shell ${id} is already open`)

  const session = await ShellSession.open(runtime, {
    terminal: { cols: options?.cols ?? 80, rows: options?.rows ?? 24 },
    onData: (chunk) => window.__wcShellData__?.(id, chunk),
  })

  shells.set(id, session)
}

/** Looks up an open shell. */
function requireShell(id: string): ShellSession {
  const session = shells.get(id)
  invariant(session, `No open shell with id ${id}`)
  return session
}

/** Runs one command in an open shell, waiting for it to finish. */
function shellExec(id: string, command: string): Promise<ShellExecResult> {
  return requireShell(id).exec(command)
}

/** Sends Ctrl-C to an open shell. */
function shellInterrupt(id: string): Promise<void> {
  return requireShell(id).interrupt()
}

/** Tells an open shell its terminal was resized. */
function shellResize(id: string, dimensions: TerminalSize): void {
  requireShell(id).resize(dimensions)
}

/**
 * Why a shell can no longer be trusted, or `null` while it is healthy.
 * A non-null value is a reset trigger, not a warning — see the ShellSession docs.
 */
function shellBrokenReason(id: string): string | null {
  return requireShell(id).brokenReason
}

/**
 * Actively proves a shell's job control still works. Costs a few seconds; the
 * authoritative check, and the only one that reads no jsh error strings.
 */
function shellVerifyJobControl(id: string): Promise<boolean> {
  return requireShell(id).verifyJobControl()
}

/** Closes a shell and forgets it. Unknown ids are ignored. */
function closeShell(id: string): void {
  shells.get(id)?.close()
  shells.delete(id)
}

/**
 * Creates the config directories package managers expect under `$HOME`.
 *
 * The runtime has no home directory prepared. npm creates `/home/.npm` for
 * itself, but pnpm opens `/home/.config/pnpm/config.yaml` without creating the
 * parent first, so the install dies with ENOENT before doing any work.
 *
 * Done through `mkdir` rather than the fs API on purpose: the fs API resolves
 * even absolute paths under the working directory (§2.2), so it would quietly
 * create `<workdir>/home/.config` — the wrong place, and the failure would look
 * identical.
 */
async function ensurePackageManagerHome(): Promise<void> {
  const made = await runCommand('mkdir', [
    '-p',
    '/home/.config/pnpm',
    '/home/.cache',
  ])

  // pnpm opens its config file rather than tolerating its absence, so the
  // directory alone is not enough — the file has to be there too. An empty file
  // is valid YAML and means "no overrides".
  const touched = await runCommand('touch', ['/home/.config/pnpm/config.yaml'])

  console.log(
    `[wc-build] Prepared package-manager home (mkdir ${made.exitCode}, touch ${touched.exitCode})`
  )
}

/**
 * Works out which package manager this project uses, from the mounted files.
 *
 * Done inside the runtime rather than on the host so there is one answer, taken
 * from exactly the tree that will be installed.
 */
async function resolvePackageManager(): Promise<
  PackageManagerChoice & PackageManagerCommand
> {
  invariant(runtime, 'Runtime not booted')

  let packageManagerField: string | undefined
  let declaredVersion: string | null = null
  try {
    const raw = await runtime.readFile('package.json')
    const parsed = JSON.parse(new TextDecoder().decode(raw))
    packageManagerField =
      typeof parsed?.packageManager === 'string'
        ? parsed.packageManager
        : undefined
    declaredVersion = parsePackageManagerVersion(packageManagerField)
  } catch {
    /* no package.json, or unreadable — fall through to lockfile detection */
  }

  const lockfiles: string[] = []
  for (const { file } of LOCKFILES) {
    try {
      await runtime.readFile(file)
      lockfiles.push(file)
    } catch {
      /* absent */
    }
  }

  const choice = detectPackageManager({ packageManagerField, lockfiles })

  // Done here rather than beside the install: `build` without `--cache` invokes
  // the manager straight from the host and never reaches installWithCache, so
  // preparing it there fixed nothing. Every path that installs asks for the
  // manager first, so this is the one place both go through.
  await ensurePackageManagerHome()

  let runtimeVersion: string | null = null
  if (declaredVersion) {
    const installed = await runCommand(choice.manager, ['--version'])
    runtimeVersion = /(\d+\.\d+\.\d+)/.exec(installed.output)?.[1] ?? null
  }

  const invocation = packageManagerCommand(
    choice.manager,
    declaredVersion,
    runtimeVersion
  )

  console.log(
    `[wc-build] Using ${choice.manager} to install (${choice.reason}; ${invocation.note})`
  )

  return { ...choice, ...invocation }
}

/** Outcome of {@link installWithCache}. */
type CacheResult = {
  /** Whether `node_modules` was restored from a snapshot instead of installed. */
  cached: boolean
  /** Lockfile hash the snapshot is keyed on. */
  key: string
  /** Size of the snapshot just written. Absent on a cache HIT. */
  bytes?: number
  // Tarball-level cache (npm's own content-addressed cacache) stats, present
  // on a node_modules MISS when the tarball cache participated.
  npmCacheRestored?: boolean
  npmCacheBytes?: number
  /** Which package manager actually performed the install. */
  manager?: PackageManager
}

// Candidate cache-key sources, most authoritative first: the first one present
// is hashed. package.json is the last resort for projects without a lockfile —
// a coarser key, but still invalidates when dependencies change.
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
// Project-root relative, NOT absolute: the runtime's filesystem root is not
// writable (npm fails with EACCES on mkdir /.npm-cache), and mount points are
// resolved against the project root anyway — so the same relative path works
// for the mount point, the `npm --cache` flag, and the export.
const NPM_CACHE_DIR = '.npm-cache'
const NPM_CACHE_OPFS = 'npm-cacache.bin' // single global OPFS blob

/** Hashes bytes to a lowercase hex SHA-256 digest. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Derives the `node_modules` cache key from the first {@link LOCK_FILES} entry
 * present in the project.
 *
 * @returns A 32-char hex prefix of the file's SHA-256.
 * @throws If the project has none of those files.
 */
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

// --- cache eviction -------------------------------------------------------
// Both caches grow without bound: a new nm-<key>.bin appears for every distinct
// lockfile (~21 MB each, so this multiplies), and the single cacache blob keeps
// accumulating tarballs (~69 MB for one small app). Snapshots get a proper LRU
// byte budget; the cacache gets a hard cap and is simply dropped when it exceeds
// it, since it is fully regenerable and only costs one online install to reseed.
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
const MAX_CACACHE_BYTES = 256 * 1024 * 1024
const CACHE_INDEX = 'cache-index.json'
const SNAPSHOT_PREFIX = 'nm-'

// OPFS exposes no usable access time, so last-used is tracked here.
type CacheIndex = Record<string, { lastUsed: number }>

// `entries()` is present on OPFS directory handles but missing from the DOM lib
// types in this TS version.
type DirWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

/** Reads the LRU index, treating a missing or corrupt one as empty. */
async function readCacheIndex(): Promise<CacheIndex> {
  const root = await opfsRoot()
  try {
    const handle = await root.getFileHandle(CACHE_INDEX)
    return JSON.parse(await (await handle.getFile()).text()) as CacheIndex
  } catch {
    return {}
  }
}

/** Overwrites the LRU index. */
async function writeCacheIndex(index: CacheIndex): Promise<void> {
  const root = await opfsRoot()
  const handle = await root.getFileHandle(CACHE_INDEX, { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(index))
  await writable.close()
}

/**
 * Marks a blob most-recently-used, so eviction reaches it last.
 *
 * @param name OPFS blob name, e.g. `nm-<key>.bin`.
 */
async function touchCacheEntry(name: string): Promise<void> {
  const index = await readCacheIndex()
  index[name] = { lastUsed: Date.now() }
  await writeCacheIndex(index)
}

/**
 * Lists the cache blobs in OPFS with their sizes, ignoring unrelated files at
 * the same origin.
 */
async function listCacheBlobs(): Promise<{ name: string; size: number }[]> {
  const root = (await opfsRoot()) as DirWithEntries
  const blobs: { name: string; size: number }[] = []

  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file') continue
    if (name !== NPM_CACHE_OPFS && !name.startsWith(SNAPSHOT_PREFIX)) continue
    const file = await (handle as FileSystemFileHandle).getFile()
    blobs.push({ name, size: file.size })
  }

  return blobs
}

/**
 * Enforces both budgets: drops the tarball cache outright if it is over its cap,
 * then evicts snapshots least-recently-used first until they fit theirs. Also
 * prunes index entries whose blob is gone.
 *
 * @param protect Blob written by the current run. Survives eviction even if it
 *   is the least-recently-used one.
 */
async function evictCache(protect: string): Promise<void> {
  const root = await opfsRoot()
  const blobs = await listCacheBlobs()
  const index = await readCacheIndex()

  const cacache = blobs.find((b) => b.name === NPM_CACHE_OPFS)
  if (cacache && cacache.size > MAX_CACACHE_BYTES) {
    await root.removeEntry(NPM_CACHE_OPFS)
    delete index[NPM_CACHE_OPFS]
    console.log(
      `[wc-build] tarball cache ${(cacache.size / 1048576).toFixed(0)} MB over ` +
        `${MAX_CACACHE_BYTES / 1048576} MB cap — dropped (reseeds next install)`
    )
  }

  const snapshots = blobs
    .filter((b) => b.name.startsWith(SNAPSHOT_PREFIX))
    .map((b) => ({ ...b, lastUsed: index[b.name]?.lastUsed ?? 0 }))
    .sort((a, b) => a.lastUsed - b.lastUsed)

  let total = snapshots.reduce((sum, b) => sum + b.size, 0)

  for (const snapshot of snapshots) {
    if (total <= MAX_SNAPSHOT_BYTES) break
    if (snapshot.name === protect) continue

    await root.removeEntry(snapshot.name)
    delete index[snapshot.name]
    total -= snapshot.size
    console.log(
      `[wc-build] evicted LRU snapshot ${snapshot.name} ` +
        `(${(snapshot.size / 1048576).toFixed(1)} MB)`
    )
  }

  // drop index entries whose blob no longer exists
  const present = new Set(blobs.map((b) => b.name))
  for (const name of Object.keys(index)) {
    if (!present.has(name) && name !== protect) delete index[name]
  }

  await writeCacheIndex(index)
}

/**
 * Mounts a snapshot into `dir`, creating the mount point first and verifying
 * the result.
 *
 * Mounting requires the mount point to already exist — otherwise the runtime
 * logs "invalid mount point" and resolves anyway, silently leaving the directory
 * empty. Hence the check: a failed mount must report as a MISS, not a broken HIT.
 *
 * @returns Whether the restore actually produced files.
 */
async function restoreSnapshotInto(
  rt: Runtime & SnapshotProvider,
  snapshot: Uint8Array,
  dir: string
): Promise<boolean> {
  await rt.mkdir(dir, { recursive: true })
  await rt.importSnapshot(snapshot, dir)

  try {
    const entries = await rt.readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Restores the `node_modules` snapshot for `key` from OPFS into the runtime and
 * marks it most-recently-used.
 *
 * @returns `false` if no snapshot exists for that key, or the mount produced
 *   nothing — either way, a cache miss.
 */
async function restoreNodeModules(
  rt: Runtime & SnapshotProvider,
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

  const restored = await restoreSnapshotInto(rt, snapshot, 'node_modules')
  if (restored) await touchCacheEntry(`nm-${key}.bin`)

  return restored
}

/**
 * Restores the executable bit on everything in `node_modules/.bin`.
 *
 * The snapshot round-trip does not preserve permissions, so a restored
 * `node_modules` has a `.bin` full of non-executable files and the first thing
 * an npm script tries to run dies with `spawn <tool> EACCES`.
 *
 * That failure is unusually nasty because **npm still exits 0**. The build
 * reports success, produces nothing, and the first sign of trouble is a
 * confusing ENOENT when the output directory turns out not to exist. It went
 * unnoticed until the daemon started taking the cache-hit path on every build.
 *
 * `chmod` follows symlinks, and `.bin` entries are symlinks into the packages,
 * so this reaches the real files.
 */
async function restoreBinPermissions(): Promise<void> {
  invariant(runtime, 'Runtime not booted')

  const { exitCode } = await runCommand('chmod', [
    '-R',
    '+x',
    'node_modules/.bin',
  ])

  if (exitCode !== 0) {
    console.warn(
      `[wc-build] Could not restore permissions on node_modules/.bin (exit ${exitCode}); ` +
        'the build may fail to spawn its tools'
    )
  }
}

/**
 * Snapshots the installed `node_modules` to OPFS under `key`, replacing any
 * existing snapshot for that key.
 *
 * @returns Size of the snapshot in bytes.
 */
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
  await touchCacheEntry(`nm-${key}.bin`)

  return snapshot.byteLength
}

/**
 * Restores the global npm tarball cache (cacache) from OPFS into the runtime,
 * so the upcoming install can replay unchanged packages offline.
 *
 * Best-effort.
 *
 * @returns `false` if no cache exists yet, or the mount produced nothing — the
 *   install then goes online and seeds one.
 */
async function restoreNpmCache(
  rt: Runtime & SnapshotProvider
): Promise<boolean> {
  const root = await opfsRoot()
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(NPM_CACHE_OPFS)
  } catch {
    return false
  }

  const file = await handle.getFile()
  const snapshot = new Uint8Array(await file.arrayBuffer())

  return restoreSnapshotInto(rt, snapshot, NPM_CACHE_DIR)
}

/**
 * Persists the (now-updated) npm tarball cache back to OPFS as a single global
 * blob. Grows over time as new packages are seen; that's the storage cost of
 * offline replay.
 *
 * @returns Size of the blob in bytes.
 */
async function saveNpmCache(provider: SnapshotProvider): Promise<number> {
  const snapshot = await provider.exportDir(NPM_CACHE_DIR)

  const root = await opfsRoot()
  const handle = await root.getFileHandle(NPM_CACHE_OPFS, { create: true })
  const writable = await handle.createWritable()
  await writable.write(snapshot as FileSystemWriteChunkType)
  await writable.close()
  await touchCacheEntry(NPM_CACHE_OPFS)

  return snapshot.byteLength
}

/**
 * Installs dependencies through the two-level OPFS cache.
 *
 * On a `node_modules` HIT nothing is installed at all. On a MISS the npm
 * tarball cache is primed first, so only packages new to this lockfile hit the
 * network, both caches are written back afterwards, and eviction runs to keep
 * them inside their budgets. Backends without snapshot support fall back to a
 * plain install.
 *
 * @throws If the install exits non-zero, or the project has no lockfile or
 *   package.json to key the cache on.
 */
async function installWithCache(): Promise<CacheResult> {
  invariant(runtime, 'Runtime not booted')

  const key = await computeCacheKey()
  const { manager, command, argsPrefix } = await resolvePackageManager()

  // The cache needs a snapshot-capable backend; otherwise fall back to a plain
  // install so a future backend without export/import still works.
  if (!isSnapshotCapable(runtime)) {
    console.log(
      '[wc-build] Runtime has no snapshot support; installing plainly'
    )
    const { exitCode } = await runCommand(command, [
      ...argsPrefix,
      ...installArgs(),
    ])
    if (exitCode !== 0) {
      throw new Error(`${manager} install failed with exit code ${exitCode}`)
    }
    return { cached: false, key, manager }
  }

  if (await restoreNodeModules(runtime, key)) {
    await restoreBinPermissions()
    console.log(`[wc-build] node_modules cache HIT (${key.slice(0, 12)})`)
    return { cached: true, key, manager }
  }

  console.log(`[wc-build] node_modules cache MISS (${key.slice(0, 12)})`)

  // Even on a full node_modules miss, prime npm's own content-addressed tarball
  // cache from OPFS so only packages new to *this* lockfile hit the network.
  // pnpm and yarn keep their own stores in their own formats, so they skip this
  // layer and rely on the node_modules snapshot alone.
  const npmCacheRestored = usesNpmTarballCache(manager)
    ? await restoreNpmCache(runtime)
    : false
  if (usesNpmTarballCache(manager)) {
    console.log(
      npmCacheRestored
        ? '[wc-build] npm tarball cache restored; installing --prefer-offline'
        : '[wc-build] no npm tarball cache yet; installing online (will seed it)'
    )
  }

  const { exitCode } = await runCommand(command, [
    ...argsPrefix,
    ...offlineInstallArgs(manager, NPM_CACHE_DIR),
  ])
  if (exitCode !== 0) {
    throw new Error(`${manager} install failed with exit code ${exitCode}`)
  }

  const bytes = await saveNodeModules(runtime, key)
  console.log(
    `[wc-build] Cached node_modules snapshot: ${(bytes / 1048576).toFixed(1)} MB`
  )

  const npmCacheBytes = usesNpmTarballCache(manager)
    ? await saveNpmCache(runtime)
    : 0
  if (usesNpmTarballCache(manager)) {
    console.log(
      `[wc-build] Updated npm tarball cache: ${(npmCacheBytes / 1048576).toFixed(1)} MB`
    )
  }

  await evictCache(`nm-${key}.bin`)

  return { cached: false, key, bytes, npmCacheRestored, npmCacheBytes }
}

/**
 * Starts a long-running command without waiting for it to exit — for dev
 * servers and watchers. Output is streamed to the page console.
 *
 * Returns immediately; a spawn failure surfaces as an unhandled rejection, not
 * to the caller.
 */
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

/**
 * Writes a single file into the runtime — how host edits reach the dev server.
 *
 * @param path Absolute path inside the runtime, e.g. `/src/main.ts`.
 * @param content UTF-8 text. Binary files are not supported here.
 */
/**
 * Deletes paths from the runtime that no longer exist on the host.
 *
 * `mount` only adds and overwrites, so without this a file deleted on the host
 * stays resolvable inside a long-lived runtime and the build keeps succeeding
 * against source that is gone.
 *
 * @param paths Root-relative paths to delete. Missing paths are ignored.
 * @returns How many paths were requested.
 */
async function removePaths(paths: string[]): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  for (const p of paths) {
    await runtime.rm(p, { recursive: true, force: true })
  }

  if (paths.length > 0) {
    console.log(`[wc-build] Removed ${paths.length} stale path(s).`)
  }
  return paths.length
}

async function writeFile(path: string, content: string): Promise<void> {
  invariant(runtime, 'Runtime not booted')

  await runtime.writeFile(path, content)

  console.log(`[wc-build] File written: ${path}`)
}

/**
 * Walks the build output and POSTs every file to the host server, which writes
 * it to the output directory.
 *
 * @param distPath Absolute path inside the runtime, e.g. `/dist`. Paths are
 *   made relative to it before upload.
 * @returns Number of files uploaded.
 * @throws If `distPath` does not exist, or any upload is rejected. Files
 *   uploaded before the failure are already on disk.
 */
async function uploadDist(distPath: string): Promise<number> {
  invariant(runtime, 'Runtime not booted')

  const rt = runtime
  let count = 0

  // A build tool that cannot spawn its own binary still exits 0 under npm, so
  // "the build succeeded" and "the build produced something" are genuinely
  // different claims. Checking here turns that case into a sentence naming the
  // problem, instead of a bare ENOENT from the directory walk below.
  try {
    await rt.readdir(distPath)
  } catch {
    throw new Error(
      `The build reported success but produced no output at ${distPath}. ` +
        'Check the build log above — a tool that fails to start can still exit 0.'
    )
  }

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
          apiUrl(`api/dist?path=${encodeURIComponent(relative)}`),
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

/**
 * Resolves when a process inside the runtime starts listening on a port.
 *
 * @returns The runtime-internal port and the URL the host can proxy to. Only
 *   the first server to come up is reported; later ones are ignored.
 * @remarks Never rejects — it waits indefinitely if no server starts, so
 *   callers should impose their own timeout.
 */
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

/**
 * The page's API, exposed on `window` and driven by the host over Puppeteer.
 * Its shape is the contract mirrored by `WCBrowser` on the Node side — changing
 * a signature here means changing it there too.
 */
const wcRunner = {
  boot,
  mountFromServer,
  runCommand,
  resolvePackageManager,
  killCommand,
  resizeCommand,
  openShell,
  shellExec,
  shellInterrupt,
  shellResize,
  shellBrokenReason,
  shellVerifyJobControl,
  closeShell,
  installWithCache,
  spawnCommand,
  writeFile,
  removePaths,
  uploadDist,
  getServerUrl,
}

window.wcRunner = wcRunner

boot().catch((err) => {
  console.error(`[wc-build] Boot failed: ${err.message}`)
})
