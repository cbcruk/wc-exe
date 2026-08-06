import { describe, expect, it } from 'vitest'
import {
  detectPackageManager,
  installArgs,
  offlineInstallArgs,
  parsePackageManagerField,
  packageManagerCommand,
  parsePackageManagerVersion,
  usesNpmTarballCache,
} from './package-manager'

describe('detectPackageManager', () => {
  it('believes the packageManager field above everything else', () => {
    const choice = detectPackageManager({
      packageManagerField: 'pnpm@9.15.9',
      lockfiles: ['package-lock.json'],
    })

    expect(choice.manager).toBe('pnpm')
    expect(choice.reason).toContain('pnpm@9.15.9')
  })

  it('falls back to the lockfile', () => {
    expect(
      detectPackageManager({ lockfiles: ['pnpm-lock.yaml'] }).manager
    ).toBe('pnpm')
    expect(detectPackageManager({ lockfiles: ['yarn.lock'] }).manager).toBe(
      'yarn'
    )
    expect(
      detectPackageManager({ lockfiles: ['package-lock.json'] }).manager
    ).toBe('npm')
  })

  // A repo migrated to pnpm often still carries the old package-lock.json.
  // Believing that one would install the tree the project moved away from.
  it('prefers pnpm over a leftover package-lock.json', () => {
    const choice = detectPackageManager({
      lockfiles: ['package-lock.json', 'pnpm-lock.yaml'],
    })

    expect(choice.manager).toBe('pnpm')
    expect(choice.reason).toContain('pnpm-lock.yaml')
  })

  it('prefers yarn over a leftover package-lock.json', () => {
    expect(
      detectPackageManager({ lockfiles: ['package-lock.json', 'yarn.lock'] })
        .manager
    ).toBe('yarn')
  })

  it('defaults to npm when there is nothing to go on', () => {
    const choice = detectPackageManager({ lockfiles: [] })

    expect(choice.manager).toBe('npm')
    expect(choice.reason).toMatch(/no lockfile/)
  })

  it('ignores a packageManager field naming something unrunnable', () => {
    const choice = detectPackageManager({
      packageManagerField: 'bun@1.0.0',
      lockfiles: ['pnpm-lock.yaml'],
    })

    expect(choice.manager).toBe('pnpm')
  })

  it('always explains itself', () => {
    for (const input of [
      { packageManagerField: 'yarn@4.0.0', lockfiles: [] },
      { lockfiles: ['pnpm-lock.yaml'] },
      { lockfiles: [] },
    ]) {
      expect(detectPackageManager(input).reason.length).toBeGreaterThan(0)
    }
  })
})

describe('parsePackageManagerField', () => {
  it('reads the manager and ignores the version', () => {
    expect(parsePackageManagerField('pnpm@9.15.9')).toBe('pnpm')
    expect(parsePackageManagerField('npm@10.8.2')).toBe('npm')
    expect(parsePackageManagerField('yarn@1.22.19')).toBe('yarn')
    expect(parsePackageManagerField('pnpm')).toBe('pnpm')
  })

  it('tolerates the hash corepack appends', () => {
    expect(parsePackageManagerField('pnpm@9.15.9+sha512.abc123')).toBe('pnpm')
  })

  it('returns null for absent or unsupported managers', () => {
    expect(parsePackageManagerField(undefined)).toBeNull()
    expect(parsePackageManagerField('')).toBeNull()
    expect(parsePackageManagerField('bun@1.0.0')).toBeNull()
  })
})

describe('parsePackageManagerVersion', () => {
  it('extracts the pinned version', () => {
    expect(parsePackageManagerVersion('pnpm@9.15.9')).toBe('9.15.9')
    expect(parsePackageManagerVersion('pnpm@9.15.9+sha512.abc')).toBe('9.15.9')
  })

  it('returns null when nothing is pinned', () => {
    expect(parsePackageManagerVersion('pnpm')).toBeNull()
    expect(parsePackageManagerVersion(undefined)).toBeNull()
  })
})

describe('install arguments', () => {
  it('installs plainly', () => {
    expect(installArgs()).toEqual(['install'])
  })

  // --cache is an npm flag and the snapshotted tarball cache is npm's cacache
  // format; handing either to pnpm or yarn would fail the install outright.
  it('only redirects the cache for npm', () => {
    expect(offlineInstallArgs('npm', '.npm-cache')).toEqual([
      'install',
      '--prefer-offline',
      '--cache',
      '.npm-cache',
    ])
    expect(offlineInstallArgs('pnpm', '.npm-cache')).toEqual(['install'])
    expect(offlineInstallArgs('yarn', '.npm-cache')).toEqual(['install'])
  })

  it('reports which managers can use the npm tarball cache', () => {
    expect(usesNpmTarballCache('npm')).toBe(true)
    expect(usesNpmTarballCache('pnpm')).toBe(false)
    expect(usesNpmTarballCache('yarn')).toBe(false)
  })
})

describe('packageManagerCommand', () => {
  it('invokes the manager directly when the majors agree', () => {
    const cmd = packageManagerCommand('pnpm', '8.15.0', '8.15.6')

    expect(cmd.command).toBe('pnpm')
    expect(cmd.argsPrefix).toEqual([])
  })

  // A pnpm 9 lockfile is unreadable to pnpm 8, which silently resolves fresh
  // and installs versions the project never pinned.
  it('pins through npx when the project needs a different major', () => {
    const cmd = packageManagerCommand('pnpm', '9.15.9', '8.15.6')

    expect(cmd.command).toBe('npx')
    expect(cmd.argsPrefix).toEqual(['-y', 'pnpm@9.15.9'])
    expect(cmd.note).toMatch(/lockfile/)
  })

  it('leaves things alone when the project pins nothing', () => {
    expect(packageManagerCommand('pnpm', null, '8.15.6').command).toBe('pnpm')
  })

  it('leaves things alone when the runtime version is unknown', () => {
    expect(packageManagerCommand('pnpm', '9.15.9', null).command).toBe('pnpm')
  })
})
