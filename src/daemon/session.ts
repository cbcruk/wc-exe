import path from 'node:path'
import { RunnerClient } from '../core/runner-client.js'
import { RunnerLink } from '../core/rpc.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  listProjectManifest,
  diffManifests,
  writeDistFile,
  type Manifest,
} from '../core/file-sync.js'
import { runProjectBuild } from '../core/project-build.js'
import type { ServerHandlers } from '../core/types.js'

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
   * Hand this session's URL to the desktop browser when it needs a page.
   *
   * `false` prints nothing and opens nothing — the caller is expected to open
   * the URL itself. Useful for tests, and for a daemon running somewhere no
   * one is watching.
   */
  open?: boolean
}

/**
 * One project held open inside the daemon: a tab, a booted container, and the
 * `node_modules` that make reuse worth anything.
 *
 * A session is deliberately **not** a cache of build results. It caches the
 * expensive, project-independent parts (a booted runtime, installed
 * dependencies) and re-derives everything project-specific each time, because
 * the failure this trades against is not a slow build but a wrong one.
 */
export class Session {
  private runner: RunnerClient | null = null
  private manifest: Manifest = new Map()
  private booted = false
  /** Set when something goes wrong badly enough that reuse is unsafe. */
  private poisoned: string | null = null

  readonly id: string
  /**
   * Control channel for this session's page.
   *
   * One per session rather than one per daemon: the pages share a server but
   * not a container, and a call routed to the wrong page would drive the wrong
   * project's build.
   */
  readonly link = new RunnerLink()
  readonly source: string
  private readonly origin: string
  private readonly open: boolean
  private lastUsed = Date.now()
  /** Output directory of the build in flight, for the dist upload route. */
  private currentOutput: string | null = null

  constructor(id: string, options: SessionOptions) {
    this.id = id
    this.source = options.source
    this.origin = options.origin
    this.open = options.open ?? true

    // A closed tab takes the container with it, so the session must forget
    // everything it believed about the runtime's contents. This is a better
    // signal than the idle timer it supplements: the timer guesses that nobody
    // is using a session, whereas this is the runtime actually being gone. Not
    // poisoned, though — nothing was left half-written, so the next build can
    // simply open a fresh tab.
    this.link.onDisconnect(() => {
      this.runner = null
      this.booted = false
      this.manifest = new Map()
    })
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

  /** Opens a tab for this session and boots its container, if not up yet. */
  private async ensureBooted(verbose: boolean): Promise<boolean> {
    if (this.booted && this.runner) return true

    const url = `${this.origin}/s/${this.id}/`
    // Printed only when the daemon is not opening it, because then nothing
    // else knows the URL: the id is minted here and the caller sees it nowhere
    // else. It reaches a terminal only under `--daemon --verbose`, which is
    // the only case where anyone is reading the daemon's output.
    if (!this.open)
      console.log(`Session ${this.id} needs a runner page: ${url}`)

    this.runner = new RunnerClient({ verbose, link: this.link })
    await this.runner.launch(url, { open: this.open })
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
      await this.runner!.removePaths(plan.remove)
    }

    // The runner pulls the whole project through the server. On a first sync
    // that is everything; afterwards it re-reads files the host says changed.
    if (plan.upsert.length) {
      await this.runner!.mountFromServer()
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

      try {
        const result = await runProjectBuild(this.runner!, {
          distDir: options.distDir,
          noInstall: options.noInstall,
          // Always, unlike the one-shot path: a session exists to be reused, so
          // the origin is stable by construction and the snapshot will be found.
          cache: true,
          timeout: options.timeout,
          // Previous artifacts must not survive into this build's output: a
          // reused runtime keeps whatever the last build produced, so a file
          // this build no longer emits would be uploaded as if it were fresh.
          //
          // UNVERIFIED. Removing this does not fail the parity test, because
          // vite empties its own outDir and hides the difference. It is kept
          // for build tools that do not, but nothing here demonstrates it
          // works — do not read the passing test as covering it.
          clearDist: true,
          mount: () => this.sync(),
          // Not emptying a directory here — the CLI already did that before it
          // asked, because deleting a caller-supplied path is the caller's
          // business. What this readies is the write target, and it runs at the
          // same moment for the same reason: a build that failed never arms it.
          prepareOutput: async () => {
            this.currentOutput = options.output
          },
          onProgress: ({ phase, message }) => {
            if (phase === 'done') log(message)
          },
        })
        return {
          reused,
          upserted: result.upserted,
          removed: result.removed,
          written: result.written,
        }
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

  /**
   * Drops this session's half of the link. Safe to call more than once.
   *
   * The tab is left open — the daemon did not open the browser and cannot close
   * it. It becomes a page talking to a session that no longer exists, which its
   * `EventSource` will retry against and get a 404 for. Harmless, but it is why
   * the daemon cannot promise to clean up after itself here.
   */
  async close(): Promise<void> {
    await this.runner?.close()
    this.runner = null
    this.booted = false
    this.manifest = new Map()
  }
}

/** Normalises a project path so the same project always maps to one session. */
export function sessionKey(source: string): string {
  return path.resolve(source)
}
