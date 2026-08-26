// Dependencies from the registry instead of from disk.
//
// `docs/virtual-filesystem.md` open item 8. The interception path reads
// `node_modules` off the disk, which means the user has to run the `npm install`
// wc-exe exists to avoid. This closes that: the host reads the lockfile, fetches
// tarballs, and unpacks them in memory into the browser's volume. Nothing is
// written into the project.
//
// The reason it is smaller than "reimplement npm" is that **a lockfile is
// already the resolution**. `package-lock.json` v2/v3's `packages` map is keyed
// by install path — `node_modules/react`, `node_modules/a/node_modules/b` — and
// carries the exact version, the tarball URL and an integrity hash. That is the
// tree layout. What is left is materialising it, and none of npm's hard part
// (peer deps, overrides, hoisting) has to be reproduced.
//
// Granularity is one package, not one file. StackBlitz's Turbo fetches
// individual files because they run infrastructure that serves packages
// unpacked; a plain registry — and an internal mirror on a closed network —
// serves whole tarballs. So the unit here is the tarball, which is also the
// unit the integrity hash covers.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

const gunzip = promisify(zlib.gunzip)

const CACHE_DIR = path.join(
  process.env.WC_EXE_CACHE_DIR ??
    path.join(process.env.HOME ?? '/tmp', '.cache/wc-exe'),
  'tarballs'
)

/** Read a NUL-terminated string out of a tar header field. */
function cstr(buf, offset, length) {
  const end = buf.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return buf.toString('utf8', offset, stop)
}

/** `%d key=value\n` records from a pax extended header. */
function paxPath(body) {
  const m = body.toString('utf8').match(/\d+ path=([^\n]+)\n/)
  return m ? m[1] : null
}

/**
 * Minimal tar reader — enough for what npm publishes, and no more.
 *
 * Regular files only. Directories, symlinks and GNU long-link headers are
 * skipped rather than guessed at; pax `path` records are honoured because npm
 * emits them for long paths. Anything unrecognised is skipped, which is the
 * safe direction: a missing file surfaces as a resolution error, where a
 * mis-parsed one would surface as a corrupt build.
 */
function untar(buf) {
  const files = new Map()
  let offset = 0
  let pendingPath = null

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break

    const name = cstr(header, 0, 100)
    const size = parseInt(cstr(header, 124, 12).trim(), 8) || 0
    const type = String.fromCharCode(header[156] || 0x30)
    const prefix = cstr(header, 345, 155)
    offset += 512
    const body = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (type === 'x' || type === 'X') {
      pendingPath = paxPath(body) ?? pendingPath
      continue
    }
    if (type === 'L') {
      pendingPath = cstr(body, 0, body.length)
      continue
    }
    if (type === 'g' || type === 'K') continue

    const full = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    pendingPath = null

    if (type === '0' || type === '\0') {
      // npm publishes everything under one top-level directory, almost always
      // `package/`. Strip whatever it is rather than assuming the name.
      const slash = full.indexOf('/')
      if (slash === -1) continue
      files.set(full.slice(slash + 1), Uint8Array.from(body))
    }
  }
  return files
}

/**
 * Every installed package, keyed by its install path.
 *
 * `dev` entries are dropped: an interception build never runs the project's
 * vite, so its devDependencies are not in the module graph. That is the same
 * cut `bench/install-shape.mjs` measures, and it is why the download is a
 * fraction of a real install.
 */
export async function readLockfile(projectDir, { includeDev = false } = {}) {
  const file = path.join(projectDir, 'package-lock.json')
  let raw
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    throw new Error(
      `--deps=registry needs a package-lock.json in ${projectDir}.\n` +
        'A lockfile is the resolution this mode materialises; without one the ' +
        "resolution would have to be recomputed, which is npm's hard part and " +
        'is out of scope here.'
    )
  }
  if (raw.lockfileVersion < 2) {
    throw new Error(
      `package-lock.json is lockfileVersion ${raw.lockfileVersion}; ` +
        'this needs v2 or v3, where `packages` is keyed by install path.'
    )
  }

  const packages = new Map()
  const skipped = []
  for (const [installPath, entry] of Object.entries(raw.packages ?? {})) {
    if (!installPath) continue // the root project itself
    if (entry.dev && !includeDev) continue
    if (entry.link) {
      skipped.push(`${installPath} (workspace link)`)
      continue
    }
    if (!entry.resolved || !entry.integrity) {
      skipped.push(`${installPath} (no tarball — git or file: dependency)`)
      continue
    }
    packages.set(installPath, {
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      optional: Boolean(entry.optional),
    })
  }
  return { packages, skipped, lockfileVersion: raw.lockfileVersion }
}

async function cachedTarball(entry) {
  const key = crypto.createHash('sha256').update(entry.integrity).digest('hex')
  const cached = path.join(CACHE_DIR, `${key}.tgz`)
  try {
    return { buf: await fs.readFile(cached), hit: true }
  } catch {
    // not cached; fall through to the network
  }

  const res = await fetch(entry.resolved)
  if (!res.ok) {
    throw new Error(`tarball fetch failed: ${entry.resolved} ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  // The integrity hash is what makes this safe to cache and safe to trust.
  const [algorithm, expected] = entry.integrity.split('-')
  const actual = crypto.createHash(algorithm).update(buf).digest('base64')
  if (actual !== expected) {
    throw new Error(
      `integrity mismatch for ${entry.resolved}\n` +
        `  expected ${entry.integrity}\n  got      ${algorithm}-${actual}`
    )
  }

  await fs.mkdir(CACHE_DIR, { recursive: true })
  await fs.writeFile(cached, buf)
  return { buf, hit: false }
}

/**
 * Fetch and unpack one package. Returns its files keyed by path relative to the
 * package root.
 *
 * Tarballs are cached on disk by integrity — a few hundred files rather than
 * the tens of thousands an extracted tree would be, which is the shape that
 * matters when the cost being avoided is per-file antivirus scanning.
 */
export async function materialise(entry) {
  const { buf, hit } = await cachedTarball(entry)
  const files = untar(await gunzip(buf))
  let bytes = 0
  for (const body of files.values()) bytes += body.length
  return { files, bytes, tarballBytes: buf.length, cacheHit: hit }
}
