/** Package managers the runtime can install with. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** Lockfile each manager writes, in detection priority order. */
export const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

/** What {@link detectPackageManager} concluded, and why. */
export interface PackageManagerChoice {
  manager: PackageManager
  /** Human-readable justification, surfaced in logs so a wrong pick is visible. */
  reason: string
}

/** How to actually invoke the chosen manager. */
export interface PackageManagerCommand {
  /** Executable to spawn — the manager itself, or `npx` when pinning. */
  command: string
  /** Arguments that must precede the subcommand. */
  argsPrefix: string[]
  /** Explanation for the log. */
  note: string
}

/**
 * Builds the invocation for a manager, pinning the version when the project
 * asks for one the runtime does not ship.
 *
 * This is not pedantry about version numbers. A lockfile written by pnpm 9
 * (`lockfileVersion: 9.0`) is unreadable to pnpm 8, which then ignores it and
 * **resolves every dependency fresh** — quietly installing different versions
 * than the project pins, so builds fail on code the author never had. Measured:
 * pnpm 8 pulled vite 7.3.6 and wrangler 4.118.0 where the lockfile said 7.3.1
 * and 4.110.0.
 *
 * `npx -y <manager>@<version>` is used because the container refuses a global
 * install (`npm i -g` fails EACCES there). npx caches the download for the life
 * of the container, so a daemon session pays it once.
 *
 * @param declaredVersion Version from `packageManager`, if any.
 * @param runtimeVersion Version the container ships, if known.
 */
export function packageManagerCommand(
  manager: PackageManager,
  declaredVersion: string | null,
  runtimeVersion: string | null
): PackageManagerCommand {
  const plain = { command: manager, argsPrefix: [], note: 'runtime version' }

  if (!declaredVersion) return plain
  if (!runtimeVersion) return plain

  const declaredMajor = declaredVersion.split('.')[0]
  const runtimeMajor = runtimeVersion.split('.')[0]
  if (declaredMajor === runtimeMajor) return plain

  return {
    command: 'npx',
    argsPrefix: ['-y', `${manager}@${declaredVersion}`],
    note:
      `pinned to ${manager}@${declaredVersion} via npx; the runtime ships ` +
      `${runtimeVersion}, which cannot read this project's lockfile`,
  }
}

/**
 * Decides which package manager to install with.
 *
 * Installing with the wrong one is not a stylistic slip: npm, pnpm and yarn
 * build **different dependency trees** from the same `package.json`. A pnpm
 * project installed with npm can pull in packages pnpm never installs and
 * resolve a subpath to the wrong one, so the build fails for a reason its
 * author has never seen locally. wc-exe used to run `npm install`
 * unconditionally, which broke roughly nine in ten real projects on the
 * machine this was measured on.
 *
 * Priority:
 *
 * 1. **`packageManager`** in package.json. The project states it outright, and
 *    corepack treats it as binding — it wins even against a stray lockfile.
 * 2. **The lockfile.** pnpm before yarn before npm: a repo migrated to pnpm
 *    often still has an old `package-lock.json` lying around, and the
 *    lockfile of the manager actually in use is the one to believe.
 * 3. **npm**, as the default that needs no lockfile.
 */
export function detectPackageManager(input: {
  /** Raw `packageManager` field, e.g. `pnpm@9.15.9`. */
  packageManagerField?: string
  /** Names of lockfiles present at the project root. */
  lockfiles: string[]
}): PackageManagerChoice {
  const declared = parsePackageManagerField(input.packageManagerField)
  if (declared) {
    return {
      manager: declared,
      reason: `package.json declares "${input.packageManagerField}"`,
    }
  }

  for (const { file, manager } of LOCKFILES) {
    if (input.lockfiles.includes(file)) {
      return { manager, reason: `found ${file}` }
    }
  }

  return { manager: 'npm', reason: 'no lockfile or packageManager field' }
}

/**
 * Reads the manager out of a corepack `packageManager` string.
 *
 * The version is deliberately ignored: the runtime ships fixed versions and
 * cannot install another, so honouring the *manager* is what matters. A version
 * mismatch is worth warning about, not worth refusing over.
 *
 * @returns `null` for anything absent or naming a manager we cannot run.
 */
export function parsePackageManagerField(
  field: string | undefined
): PackageManager | null {
  if (!field) return null

  const name = field.trim().split('@')[0].toLowerCase()
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return name
  return null
}

/** The version a `packageManager` field pins, if it pins one. */
export function parsePackageManagerVersion(
  field: string | undefined
): string | null {
  if (!field) return null
  const match = /^[a-z]+@(\d[^+\s]*)/i.exec(field.trim())
  return match ? match[1] : null
}

/**
 * Arguments for a plain install.
 *
 * The same for all three today; kept as a function so a manager that needs
 * different arguments has one obvious place to be handled.
 */
export function installArgs(): string[] {
  return ['install']
}

/**
 * Arguments for an install that should prefer an existing local package cache.
 *
 * Only npm gets the cache redirection: `--cache` is npm's flag, and the tarball
 * cache wc-exe snapshots is npm's cacache format. pnpm and yarn keep their own
 * stores elsewhere and would reject the flag, so they get a plain install and
 * rely on the `node_modules` snapshot instead.
 */
export function offlineInstallArgs(
  manager: PackageManager,
  npmCacheDir: string
): string[] {
  if (manager !== 'npm') return ['install']
  return ['install', '--prefer-offline', '--cache', npmCacheDir]
}

/** Whether this manager can use wc-exe's npm-format tarball cache. */
export function usesNpmTarballCache(manager: PackageManager): boolean {
  return manager === 'npm'
}
