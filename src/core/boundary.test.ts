import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const coreDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Packages that make something a *command-line program* rather than a library:
 * argument parsing, spinners, colour, file watching, port proxying.
 *
 * The bridge is meant to outlive this CLI. A dependency on any of these would
 * quietly weld it to one, and nothing about a passing build would say so.
 */
const CLI_ONLY_DEPENDENCIES = [
  'commander',
  'ora',
  'chalk',
  'chokidar',
  'http-proxy',
]

/** Directories core must not reach into, because they are its consumers. */
const CONSUMER_DIRECTORIES = ['commands', 'daemon', 'utils']

function coreSources(): string[] {
  return fs
    .readdirSync(coreDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(coreDir, name))
}

function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8')
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
}

describe('the core boundary', () => {
  it('has sources to check', () => {
    // Guards the checks below: if the glob broke they would all pass vacuously.
    expect(coreSources().length).toBeGreaterThan(5)
  })

  it('does not depend on anything that makes this a CLI', () => {
    const violations: string[] = []

    for (const file of coreSources()) {
      for (const specifier of importsOf(file)) {
        if (CLI_ONLY_DEPENDENCIES.includes(specifier)) {
          violations.push(`${path.basename(file)} imports ${specifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('does not reach into its own consumers', () => {
    const violations: string[] = []

    for (const file of coreSources()) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue
        const resolved = path.resolve(path.dirname(file), specifier)
        for (const consumer of CONSUMER_DIRECTORIES) {
          if (resolved.includes(`${path.sep}${consumer}${path.sep}`)) {
            violations.push(`${path.basename(file)} imports ${specifier}`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('exposes a single entry point that names what the bridge offers', () => {
    const index = fs.readFileSync(path.join(coreDir, 'index.ts'), 'utf8')

    for (const expected of [
      'RunnerClient',
      'RunnerLink',
      'runProjectBuild',
      'startServer',
      'listProjectFiles',
      'openInBrowser',
    ]) {
      expect(index).toContain(expected)
    }
  })
})
