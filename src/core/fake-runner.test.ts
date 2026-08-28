import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer, type ServerInfo } from './server.js'
import { RunnerClient } from './runner-client.js'
import { FakeRunnerPage, type FakeRunnerOptions } from './fake-runner.js'
import { runProjectBuild } from './project-build.js'
import {
  listProjectFiles,
  readProjectFileBytes,
  writeDistFile,
} from './file-sync.js'
import { isWcError } from './errors.js'
import type { ServerHandlers } from './types.js'

/**
 * The contract the in-memory runner has to hold to be worth testing against.
 *
 * Everything here runs over a real socket through the real `RunnerLink` and
 * `RunnerClient` — the fake starts at the runtime and goes no higher. That is
 * the whole reason it exists: if the fake were reached through a double, these
 * tests would prove the double works.
 *
 * What it cannot prove is that a real project builds; no command runs here.
 * `test/integration/` is where that lives, and it needs a browser.
 */

let running: ServerInfo | undefined
let page: FakeRunnerPage | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await page?.close()
  page = undefined
  await running?.shutdown()
  running = undefined
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  )
})

/** A project on disk, so the host's routes have something real to serve. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-fake-'))
  tempDirs.push(dir)
  for (const [relPath, contents] of Object.entries(files)) {
    const target = path.join(dir, relPath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }
  return dir
}

/** Host, runner client and fake page, all attached to each other. */
async function attach(options: {
  source: string
  output?: string
  run?: FakeRunnerOptions['run']
  /** Replaces the host-side routes, for tests about what the host answers. */
  handlers?: Partial<ServerHandlers>
}): Promise<{ runner: RunnerClient; page: FakeRunnerPage; url: string }> {
  const info = await startServer(
    {
      listFiles: () => listProjectFiles(options.source),
      readFile: (relPath) => readProjectFileBytes(options.source, relPath),
      writeDistFile: (relPath, data) =>
        writeDistFile(options.output ?? options.source, relPath, data),
      ...options.handlers,
    },
    0,
    // No page is served: the runner below attaches over the control channel and
    // never loads one, so requiring a built bundle would tie this tier to a
    // build step for no gain.
    { runnerDist: null }
  )
  running = info

  const runner = new RunnerClient({ link: info.link })
  const [attached] = await Promise.all([
    FakeRunnerPage.open({ url: info.url, run: options.run }),
    runner.launch(info.url, { open: false }),
  ])
  page = attached
  return { runner, page: attached, url: info.url }
}

describe('mounting a project into the fake runtime', () => {
  it('pulls every file the host advertises, through the host routes', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'src/main.ts': 'export const main = 1',
    })
    const { runner, page } = await attach({ source })

    expect(await runner.mountFromServer()).toBe(2)
    expect(page.fs.paths()).toEqual(['/package.json', '/src/main.ts'])
    expect(page.fs.read('/src/main.ts')).toBe('export const main = 1')
  })

  it('reports a mount failure with the path that could not be fetched', async () => {
    // A host that advertises a file it cannot then serve. Rare in practice, and
    // exactly what a project changing under a build looks like from the page.
    const source = await project({ 'a.ts': 'a' })
    const { runner } = await attach({
      source,
      handlers: { listFiles: () => Promise.resolve(['a.ts', 'vanished.ts']) },
    })

    await expect(runner.mountFromServer()).rejects.toMatchObject({
      _tag: 'MountFailed',
      path: 'vanished.ts',
    })
  })
})

describe('removing paths', () => {
  it('takes a directory and everything under it', async () => {
    const source = await project({
      'a.ts': 'a',
      'dist/one.js': '1',
      'dist/nested/two.js': '2',
    })
    const { runner, page } = await attach({ source })
    await runner.mountFromServer()

    await runner.removePaths(['dist'])

    expect(page.fs.paths()).toEqual(['/a.ts'])
  })

  it('ignores a path that is not there, so clearDist works on a fresh runtime', async () => {
    const source = await project({ 'a.ts': 'a' })
    const { runner, page } = await attach({ source })
    await runner.mountFromServer()

    await expect(runner.removePaths(['dist'])).resolves.toBe(1)
    expect(page.fs.paths()).toEqual(['/a.ts'])
  })
})

describe('uploading build output', () => {
  it('writes each artifact back to the host, relative to the output root', async () => {
    const source = await project({ 'package.json': '{}' })
    const output = await project({})
    const { runner, page } = await attach({ source, output })

    page.fs.write('/dist/index.html', '<!doctype html>')
    page.fs.write('/dist/assets/app.js', 'console.log(1)')

    expect(await runner.uploadDist('/dist')).toBe(2)
    expect(await fs.readFile(path.join(output, 'index.html'), 'utf8')).toBe(
      '<!doctype html>'
    )
    expect(await fs.readFile(path.join(output, 'assets/app.js'), 'utf8')).toBe(
      'console.log(1)'
    )
  })

  it('says the build produced nothing rather than failing on an empty walk', async () => {
    const source = await project({ 'package.json': '{}' })
    const { runner } = await attach({ source })

    await expect(runner.uploadDist('/dist')).rejects.toMatchObject({
      _tag: 'NoBuildOutput',
      distPath: '/dist',
    })
  })
})

describe('a method the fake does not implement', () => {
  it('crosses as a named runtime failure, not a hang', async () => {
    const source = await project({ 'package.json': '{}' })
    const { runner } = await attach({ source })

    const failure = await runner
      .shellExec('sh', 'echo hi')
      .catch((e: unknown) => e)

    expect(isWcError(failure)).toBe(true)
    expect(failure).toMatchObject({
      _tag: 'RuntimeFailure',
      operation: 'shellExec',
    })
  })
})

describe('a whole build sequence', () => {
  it('runs the steps in order and lands the artifacts on the host', async () => {
    const source = await project({
      'package.json': '{"name":"demo"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'src/main.ts': 'export const main = 1',
    })
    const output = await project({})
    const { runner, page } = await attach({
      source,
      output,
      run: (command, runtime) => {
        if (command.args.includes('build')) {
          runtime.write('/dist/index.html', '<!doctype html>')
        }
      },
    })

    const steps: string[] = []
    const result = await runProjectBuild(runner, {
      distDir: '/dist',
      noInstall: false,
      cache: true,
      clearDist: true,
      mount: async () => ({
        upserted: await runner.mountFromServer(),
        removed: 0,
      }),
      onProgress: ({ step, phase }) => {
        if (phase === 'start') steps.push(step)
      },
    })

    expect(steps).toEqual([
      'mount',
      'packageManager',
      'install',
      'clearDist',
      'build',
      'upload',
    ])
    // Resolved from the lockfile that was actually mounted, not from a stub.
    expect(result.choice.manager).toBe('pnpm')
    expect(result.written).toBe(1)
    expect(page.commands.at(-1)).toMatchObject({
      cmd: 'pnpm',
      args: ['run', 'build'],
    })
    expect(await fs.readFile(path.join(output, 'index.html'), 'utf8')).toBe(
      '<!doctype html>'
    )
  })

  it('carries a non-zero build exit across the socket with its output', async () => {
    const source = await project({ 'package.json': '{}' })
    const { runner } = await attach({
      source,
      run: (command) =>
        command.args.includes('build')
          ? { exitCode: 2, output: 'src/main.ts(1,1): error TS2304' }
          : undefined,
    })

    const failure = await runProjectBuild(runner, {
      distDir: '/dist',
      noInstall: true,
      cache: false,
      clearDist: false,
      mount: async () => ({
        upserted: await runner.mountFromServer(),
        removed: 0,
      }),
    }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ _tag: 'CommandFailed', exitCode: 2 })
    expect((failure as Error).message).toContain('error TS2304')
  })
})
