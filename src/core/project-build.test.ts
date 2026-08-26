import { describe, expect, it } from 'vitest'
import { runProjectBuild, type BuildRunner } from './project-build.js'
import type { CommandResult, PackageManagerChoice } from './types.js'

/**
 * The bug these exist for: the daemon built with the bare manager name while
 * the one-shot path built with `command` + `argsPrefix`, so a project pinning
 * `packageManager: "pnpm@9.1.0"` got `npx -y pnpm@9.1.0 run build` on one path
 * and whatever pnpm the runtime ships on the other.
 *
 * `daemon-parity.mjs` could not see it — it compares two paths' artifacts, and
 * no fixture pins a manager, so both paths ran the same command and matched.
 * The check has to be on the invocation itself.
 */

/** Records every command a build spawns. */
function fakeRunner(
  choice: Partial<PackageManagerChoice> = {}
): BuildRunner & { spawned: Array<{ command: string; args: string[] }> } {
  const spawned: Array<{ command: string; args: string[] }> = []
  return {
    spawned,
    packageManager: async () => ({
      manager: 'npm',
      reason: 'package-lock.json',
      command: 'npm',
      argsPrefix: [],
      note: 'runtime version',
      ...choice,
    }),
    installWithCache: async () => ({ cached: true, key: 'deadbeefcafe0000' }),
    runCommand: async (command: string, args: string[]) => {
      spawned.push({ command, args })
      return { exitCode: 0, output: '' } as CommandResult
    },
    removePaths: async () => 1,
    uploadDist: async () => 3,
  }
}

const base = {
  distDir: '/dist',
  noInstall: false,
  cache: false,
  clearDist: false,
  mount: async () => ({ upserted: 4, removed: 0 }),
}

describe('the shared build sequence', () => {
  it('builds with the pinned invocation, not the bare manager name', async () => {
    const runner = fakeRunner({
      manager: 'pnpm',
      command: 'npx',
      argsPrefix: ['-y', 'pnpm@9.1.0'],
      reason: 'packageManager field',
    })

    await runProjectBuild(runner, base)

    expect(runner.spawned).toContainEqual({
      command: 'npx',
      args: ['-y', 'pnpm@9.1.0', 'run', 'build'],
    })
  })

  it('installs with the pinned invocation too', async () => {
    const runner = fakeRunner({
      manager: 'pnpm',
      command: 'npx',
      argsPrefix: ['-y', 'pnpm@9.1.0'],
    })

    await runProjectBuild(runner, base)

    expect(runner.spawned).toContainEqual({
      command: 'npx',
      args: ['-y', 'pnpm@9.1.0', 'install'],
    })
  })

  it('skips the install step but still builds', async () => {
    const runner = fakeRunner()

    await runProjectBuild(runner, { ...base, noInstall: true })

    expect(runner.spawned).toEqual([{ command: 'npm', args: ['run', 'build'] }])
  })

  it('takes the OPFS path instead of spawning an install when cache is on', async () => {
    const runner = fakeRunner()

    const result = await runProjectBuild(runner, { ...base, cache: true })

    expect(result.install).toBe('cached')
    expect(runner.spawned.map((s) => s.args)).toEqual([['run', 'build']])
  })

  it('prepares the output only after the build has succeeded', async () => {
    // A failed build must leave the previous artifacts on disk. Ordering is the
    // whole guarantee, so it is asserted rather than assumed.
    const order: string[] = []
    const runner = fakeRunner()
    const failing: BuildRunner = {
      ...runner,
      runCommand: async (_command: string, args: string[]) => {
        order.push(`run:${args.join(' ')}`)
        return {
          exitCode: args.includes('build') ? 1 : 0,
          output: 'boom',
        } as CommandResult
      },
    }

    await expect(
      runProjectBuild(failing, {
        ...base,
        prepareOutput: async () => {
          order.push('prepareOutput')
        },
      })
    ).rejects.toThrow(/run build/)

    expect(order).not.toContain('prepareOutput')
  })

  it('reports each step as it starts and finishes', async () => {
    const seen: string[] = []

    await runProjectBuild(fakeRunner(), {
      ...base,
      clearDist: true,
      onProgress: ({ step, phase }) => seen.push(`${step}:${phase}`),
    })

    expect(seen).toEqual([
      'mount:start',
      'mount:done',
      'packageManager:start',
      'packageManager:done',
      'install:start',
      'install:done',
      'clearDist:start',
      'clearDist:done',
      'build:start',
      'build:done',
      'upload:start',
      'upload:done',
    ])
  })
})
