import { commandFailure } from './errors.js'
import type { RunnerClient } from './runner-client.js'
import type { PackageManagerChoice } from './types.js'

/**
 * The one build sequence, shared by every caller that runs one.
 *
 * It exists because there used to be two. `commands/build.ts` drove the steps
 * itself and so did `daemon/Session.build`, and the two drifted: the one-shot
 * path built with `command` + `argsPrefix` — which is `npx -y pnpm@9.1.0` for a
 * project that pins its manager — while the daemon built with the bare
 * `manager`, i.e. whatever version the runtime happens to ship. Same project,
 * two different builds, and `daemon-parity.mjs` could not see it because no
 * fixture pinned a manager.
 *
 * That is the kind of divergence that does not announce itself: both paths
 * succeed, and the artifacts differ only when the pinned version would have
 * behaved differently. Keeping one implementation is the only real fix — a
 * second copy will drift again.
 *
 * What legitimately differs between callers is passed in rather than branched
 * on here: how the project reaches the runtime ({@link ProjectBuildOptions.mount}),
 * and what to do to the host's output directory before artifacts land in it
 * ({@link ProjectBuildOptions.prepareOutput}).
 */

/**
 * The slice of {@link RunnerClient} a build actually uses.
 *
 * Narrowed rather than taking the whole client so a test double is a plain
 * object rather than a cast. §18.3 of `docs/persistent-runner.md` records why
 * that matters: an `as unknown as` fake keeps compiling however the interface
 * moves, so the test stops noticing drift precisely when drift is the risk.
 */
export type BuildRunner = Pick<
  RunnerClient,
  | 'packageManager'
  | 'installWithCache'
  | 'runCommand'
  | 'removePaths'
  | 'uploadDist'
>

/** Steps a build goes through, in order. */
export type BuildStep =
  | 'mount'
  | 'packageManager'
  | 'install'
  | 'clearDist'
  | 'build'
  | 'upload'

/** Progress report, so callers can render a spinner or collect log lines. */
export interface BuildProgress {
  step: BuildStep
  /** `start` before the step runs; `done` once it has succeeded. */
  phase: 'start' | 'done'
  /** Human-readable line. On `done` it describes what actually happened. */
  message: string
}

/** What {@link ProjectBuildOptions.mount} reports. */
export interface MountResult {
  /** Files written into the runtime. */
  upserted: number
  /** Paths deleted from the runtime because the host no longer has them. */
  removed: number
}

export interface ProjectBuildOptions {
  /** Build output path *inside* the runtime, e.g. `/dist`. */
  distDir: string
  /** Build against whatever `node_modules` is already there. */
  noInstall: boolean
  /**
   * Install through the OPFS snapshot instead of plainly.
   *
   * Only worth it when the runner has a stable origin; otherwise OPFS starts
   * empty and the snapshot is written for a run that will never find it.
   */
  cache: boolean
  /** Per-command timeout in milliseconds. Omit to wait indefinitely. */
  timeout?: number
  /**
   * Delete the previous build's output inside the runtime first.
   *
   * Only meaningful for a reused runtime: a fresh one holds nothing. Without it
   * a long-lived session would upload a file this build no longer emits as if
   * it were fresh.
   */
  clearDist: boolean
  /** Brings the runtime's copy of the project in line with the host. */
  mount: () => Promise<MountResult>
  /**
   * Readies the host's output directory. Called immediately before artifacts
   * are uploaded — **after** the build has succeeded, so a failed build leaves
   * the previous output alone.
   *
   * Omitted by callers whose output directory is prepared by someone else, as
   * the daemon's is: emptying a caller-supplied path is the caller's business,
   * not a long-lived service's.
   */
  prepareOutput?: () => Promise<void>
  onProgress?: (progress: BuildProgress) => void
}

export interface ProjectBuildResult {
  /** The manager that was resolved, and how it was invoked. */
  choice: PackageManagerChoice
  upserted: number
  removed: number
  /** What the install step did. */
  install: 'skipped' | 'cached' | 'installed'
  /** OPFS snapshot key, when one was involved. */
  cacheKey?: string
  /** Artifacts written back to the host. */
  written: number
}

/** Runs one build against an attached runner. */
export async function runProjectBuild(
  runner: BuildRunner,
  options: ProjectBuildOptions
): Promise<ProjectBuildResult> {
  const report = (
    step: BuildStep,
    phase: 'start' | 'done',
    message: string
  ): void => options.onProgress?.({ step, phase, message })

  report('mount', 'start', 'Mounting files...')
  const { upserted, removed } = await options.mount()
  report(
    'mount',
    'done',
    removed > 0
      ? `Mounted ${upserted} files, removed ${removed}`
      : `Mounted ${upserted} files`
  )

  // Re-resolved every build, never remembered: a project can gain or change a
  // lockfile between runs, and a long-lived session must not keep installing
  // with the manager it happened to see first.
  report('packageManager', 'start', 'Resolving package manager...')
  const choice = await runner.packageManager()
  report(
    'packageManager',
    'done',
    `Package manager: ${choice.manager} (${choice.reason}; ${choice.note})`
  )

  let install: ProjectBuildResult['install'] = 'skipped'
  let cacheKey: string | undefined

  if (!options.noInstall) {
    if (options.cache) {
      report('install', 'start', 'Installing dependencies (with OPFS cache)...')
      const result = await runner.installWithCache()
      install = result.cached ? 'cached' : 'installed'
      cacheKey = result.key
      report(
        'install',
        'done',
        result.cached
          ? `Restored node_modules from cache (${result.key.slice(0, 12)})`
          : `Installed and cached node_modules (${((result.bytes ?? 0) / 1048576).toFixed(1)} MB)`
      )
    } else {
      report(
        'install',
        'start',
        `Installing dependencies (${choice.manager} install)...`
      )
      const result = await runner.runCommand(
        choice.command,
        [...choice.argsPrefix, 'install'],
        { timeout: options.timeout }
      )
      if (result.exitCode !== 0)
        throw commandFailure(`${choice.manager} install`, result)
      install = 'installed'
      report('install', 'done', 'Dependencies installed')
    }
  }

  if (options.clearDist) {
    report('clearDist', 'start', 'Clearing previous build output...')
    await runner.removePaths([options.distDir.replace(/^\//, '')])
    report('clearDist', 'done', 'Cleared previous build output')
  }

  // `choice.command` and `choice.argsPrefix`, not `choice.manager`: a project
  // that pins `packageManager` must build with the version it pinned. This is
  // the line the daemon used to get wrong.
  report('build', 'start', `Building project (${choice.manager} run build)...`)
  const build = await runner.runCommand(
    choice.command,
    [...choice.argsPrefix, 'run', 'build'],
    { timeout: options.timeout }
  )
  if (build.exitCode !== 0)
    throw commandFailure(`${choice.manager} run build`, build)
  report('build', 'done', 'Build completed')

  await options.prepareOutput?.()

  report('upload', 'start', 'Writing dist files...')
  const written = await runner.uploadDist(options.distDir)
  report('upload', 'done', `Wrote ${written} files`)

  return { choice, upserted, removed, install, cacheKey, written }
}
