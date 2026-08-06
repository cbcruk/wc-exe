import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locates the built runner bundle (`src/runner/dist`).
 *
 * Resolving it with a fixed `../` count only works if you know how deep the
 * bundler placed the calling module, which is a build detail rather than
 * something to encode — the daemon and the one-shot server ended up at
 * different depths and the daemon silently served 404s for every asset until
 * the page timed out with no indication why.
 *
 * So the candidates are checked, and a miss throws here — at startup, naming
 * every path tried — instead of surfacing later as a runtime that never boots.
 */
export function resolveRunnerDist(): string {
  const candidates = [
    // Published/bundled: dist/… or dist/<subdir>/… inside the package.
    path.resolve(here, '../src/runner/dist'),
    path.resolve(here, '../../src/runner/dist'),
    path.resolve(here, '../../../src/runner/dist'),
  ]

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate
  }

  throw new Error(
    'Could not find the built runner bundle. Run `pnpm build` first.\n' +
      `Looked in:\n  ${candidates.join('\n  ')}`
  )
}
