import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  diffManifests,
  listProjectManifest,
  type Manifest,
} from './file-sync.js'

function manifest(entries: Record<string, string>): Manifest {
  return new Map(Object.entries(entries))
}

describe('diffManifests', () => {
  it('writes everything and removes nothing for a fresh runtime', () => {
    const plan = diffManifests(
      manifest({}),
      manifest({ 'a.ts': '1:1', 'b.ts': '2:2' })
    )

    expect(plan.upsert.sort()).toEqual(['a.ts', 'b.ts'])
    expect(plan.remove).toEqual([])
  })

  it('skips files whose stamp is unchanged', () => {
    const prev = manifest({ 'a.ts': '1:1', 'b.ts': '2:2' })
    const plan = diffManifests(prev, manifest({ 'a.ts': '1:1', 'b.ts': '2:2' }))

    expect(plan.upsert).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('upserts a file whose stamp changed', () => {
    const plan = diffManifests(
      manifest({ 'a.ts': '1:1', 'b.ts': '2:2' }),
      manifest({ 'a.ts': '1:1', 'b.ts': '2:9' })
    )

    expect(plan.upsert).toEqual(['b.ts'])
    expect(plan.remove).toEqual([])
  })

  // The reason this module exists: without it a deleted file lingers in a
  // long-lived runtime and the build can still resolve it.
  it('removes a file that disappeared from the host', () => {
    const plan = diffManifests(
      manifest({ 'a.ts': '1:1', 'gone.ts': '2:2' }),
      manifest({ 'a.ts': '1:1' })
    )

    expect(plan.upsert).toEqual([])
    expect(plan.remove).toEqual(['gone.ts'])
  })

  it('handles an add, a change and a delete together', () => {
    const plan = diffManifests(
      manifest({ 'keep.ts': '1:1', 'edit.ts': '2:2', 'gone.ts': '3:3' }),
      manifest({ 'keep.ts': '1:1', 'edit.ts': '2:9', 'new.ts': '4:4' })
    )

    expect(plan.upsert.sort()).toEqual(['edit.ts', 'new.ts'])
    expect(plan.remove).toEqual(['gone.ts'])
  })

  it('removes everything when the project is emptied', () => {
    const plan = diffManifests(manifest({ 'a.ts': '1:1' }), manifest({}))

    expect(plan.upsert).toEqual([])
    expect(plan.remove).toEqual(['a.ts'])
  })
})

describe('listProjectManifest', () => {
  it('stamps files and changes the stamp when contents change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-manifest-'))
    try {
      await fs.mkdir(path.join(dir, 'src'))
      await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1')
      await fs.writeFile(path.join(dir, 'package.json'), '{}')

      const before = await listProjectManifest(dir)
      expect([...before.keys()].sort()).toEqual(['package.json', 'src/a.ts'])

      await fs.writeFile(
        path.join(dir, 'src', 'a.ts'),
        'export const a = 1 // longer now'
      )
      const after = await listProjectManifest(dir)

      expect(after.get('src/a.ts')).not.toBe(before.get('src/a.ts'))
      expect(after.get('package.json')).toBe(before.get('package.json'))

      const plan = diffManifests(before, after)
      expect(plan.upsert).toEqual(['src/a.ts'])
      expect(plan.remove).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('excludes node_modules and build output', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-exe-manifest-'))
    try {
      await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true })
      await fs.mkdir(path.join(dir, 'dist'))
      await fs.writeFile(path.join(dir, 'node_modules', 'x', 'i.js'), '1')
      await fs.writeFile(path.join(dir, 'dist', 'out.js'), '1')
      await fs.writeFile(path.join(dir, 'index.html'), '<html></html>')

      const found = await listProjectManifest(dir)

      expect([...found.keys()]).toEqual(['index.html'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
