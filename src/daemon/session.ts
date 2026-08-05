import path from 'node:path'
import type { Browser } from 'puppeteer-core'
import { WCBrowser } from '../core/browser.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  listProjectManifest,
  diffManifests,
  writeDistFile,
  type Manifest,
} from '../core/file-sync.js'
import { commandFailure } from '../core/command-error.js'
import type { CommandResult, ServerHandlers } from '../core/types.js'

/** How a session reports what it did, for the CLI to print. */
export interface SessionBuildResult {
  /** Whether the container was already booted when this build started. */
  reused: boolean
  /** Files pushed into the runtime for this build. */
  upserted: number
  /** Paths deleted from the runtime because they are gone from the host. */
  removed: number
  /** Artifacts written back to the host. */
  written: number
}

/** What a session needs to exist. */
export interface SessionOptions {
  /** Absolute host path of the project. */
  source: string
  /** Origin the daemon serves from, e.g. `http://127.0.0.1:5199`. */
  origin: string
  /**
   * Supplies the browser every session opens its page on.
   *
   * Shared rather than one-per-session because Chrome permits a single process
   * per profile directory and aborts otherwise — with a browser apiece, opening
   * a second project failed before it started.
   *
   * A function so the browser is launched on first use rather than at daemon
   * startup, and so all sessions await the same launch.
   */
  getBrowser: () => Promise<Browser>
}

/**
 * One project held open inside the daemon: a page, a booted container, and the
 * `node_modules` that make reuse worth anything.
 *
 * A session is deliberately **not** a cache of build results. It caches the
 * expensive, project-independent parts (a booted runtime, installed
 * dependencies) and re-derives everything project-specific each time, because
 * the failure this trades against is not a slow build but a wrong one.
 */
export class Session {
  private browser: WCBrowser | null = null
  private manifest: Manifest = new Map()
  private booted = false
  /** Set when something goes wrong badly enough that reuse is unsafe. */
  private poisoned: string | null = null

  readonly id: string
  readonly source: string
  private readonly origin: string
  private readonly getBrowser: () => Promise<Browser>
  private lastUsed = Date.now()
  /** Output directory of the build in flight, for the dist upload route. */
  private currentOutput: string | null = null

  constructor(id: string, options: SessionOptions) {
    this.id = id
    this.source = options.source
    this.origin = options.origin
    this.getBrowser = options.getBrowser
  }

  /** When this session was last used, for idle eviction. */
  get lastUsedAt(): number {
    return this.lastUsed
  }

  /** Why this session must not be reused, or `null` when it is fine. */
  get poisonedReason(): string | null {
    return this.poisoned
  }

  /**
   * Runner-plane handlers for this session.
   *
   * `writeDistFile` targets whichever build is in flight; a request arriving
   * outside a build is refused rather than written somewhere arbitrary.
   */
  handlers(): ServerHandlers {
    return {
      listFiles: () => listProjectFiles(this.source),
      readFile: (relPath) => readProjectFileBytes(this.source, relPath),
      writeDistFile: async (relPath, data) => {
        if (!this.currentOutput) {
          throw new Error('No build in progress for this session')
        }
        await writeDistFile(this.currentOutput, relPath, data)
      },
    }
  }

  /** Boots the page and container if they are not up yet. */
  private async ensureBooted(verbose: boolean): Promise<boolean> {
    if (this.booted && this.browser) return true

    this.browser = new WCBrowser({
      verbose,
      browser: await this.getBrowser(),
    })
    await this.browser.launch(`${this.origin}/s/${this.id}/`)
    this.booted = true
    // A fresh container holds nothing, so the next sync must push everything.
    this.manifest = new Map()
    return false
  }

  /**
   * Brings the runtime's copy of the project in line with the host.
   *
   * Additions and changes are mounted; **paths that disappeared from the host
   * are deleted**. Mounting alone only adds and overwrites, so without the
   * delete a file removed on the host would stay resolvable in a long-lived
   * container and the build would keep succeeding against source that no longer
   * exists — the worst outcome available here, since it looks like success.
   */
  private async sync(): Promise<{ upserted: number; removed: number }> {
    const next = await listProjectManifest(this.source)
    const plan = diffManifests(this.manifest, next)

    if (plan.remove.length) {
      await this.browser!.removePaths(plan.remove)
    }

    // The runner pulls the whole project through the server. On a first sync
    // that is everything; afterwards it re-reads files the host says changed.
    if (plan.upsert.length) {
      await this.browser!.mountFromServer()
    }

    this.manifest = next
    return { upserted: plan.upsert.length, removed: plan.remove.length }
  }

  /**
   * Runs one build.
   *
   * @throws If any step fails. The session is poisoned on failures that leave
   *   the runtime in an unknown state, so the next build starts clean rather
   *   than inheriting the mess.
   */
  async build(options: {
    output: string
    distDir: string
    noInstall: boolean
    verbose: boolean
    timeout?: number
    onLog?: (line: string) => void
  }): Promise<SessionBuildResult> {
    if (this.poisoned) {
      throw new Error(`Session is unusable: ${this.poisoned}`)
    }

    this.lastUsed = Date.now()
    const log = options.onLog ?? ((): void => {})

    try {
      const reused = await this.ensureBooted(options.verbose)
      log(reused ? 'Reusing booted container' : 'Booted container')

      const { upserted, removed } = await this.sync()
      log(`Synced project (${upserted} written, ${removed} removed)`)

      // Re-resolved every build: a project can gain or change a lockfile
      // between runs, and a long-lived session must not keep installing with
      // the manager it happened to see first.
      const { manager, reason } = await this.browser!.packageManager()
      log(`Package manager: ${manager} (${reason})`)

      if (!options.noInstall) {
        const result = await this.browser!.installWithCache()
        log(
          result.cached
            ? `Dependencies restored from cache (${result.key.slice(0, 12)})`
            : 'Dependencies installed'
        )
      }

      // Previous artifacts must not survive into this build's output: the
      // runtime keeps whatever the last build produced, so a file this build no
      // longer emits would be uploaded as if it were fresh.
      //
      // UNVERIFIED. Removing this line does not fail the parity test, because
      // vite empties its own outDir and hides the difference. It is kept for
      // build tools that do not, but nothing here demonstrates it works — do
      // not read the passing test as covering it.
      await this.browser!.removePaths([options.distDir.replace(/^\//, '')])
      log('Cleared previous build output')

      const build: CommandResult = await this.browser!.runCommand(
        manager,
        ['run', 'build'],
        { timeout: options.timeout }
      )
      if (build.exitCode !== 0)
        throw commandFailure(`${manager} run build`, build)
      log('Build completed')

      this.currentOutput = options.output
      try {
        const written = await this.browser!.uploadDist(options.distDir)
        log(`Wrote ${written} files`)
        return { reused, upserted, removed, written }
      } finally {
        this.currentOutput = null
      }
    } catch (error) {
      // A build that failed part-way may have left the runtime holding
      // half-written state we cannot characterise. Reuse is only safe when we
      // know what is in there.
      this.poisoned = (error as Error).message
      throw error
    } finally {
      this.lastUsed = Date.now()
    }
  }

  /** Tears down the page and container. Safe to call more than once. */
  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = null
    this.booted = false
    this.manifest = new Map()
  }
}

/** Normalises a project path so the same project always maps to one session. */
export function sessionKey(source: string): string {
  return path.resolve(source)
}
