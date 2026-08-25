// What does an interception build actually need out of `npm install`?
//
// `docs/virtual-filesystem.md` §9 records the interception PoC's largest gap:
// it does not install anything, it reads `node_modules` off disk. Closing that
// means the host fetching tarballs and unpacking them into the browser's
// volume — and the blocker §9 names is step 5 of an install, **lifecycle
// scripts**, which need a process model a virtual filesystem cannot provide.
//
// That blocker is the right answer to "reproduce `npm install` faithfully". It
// may be the wrong answer to "produce the module graph an interception build
// needs", which is a smaller question: a build that never runs the project's
// vite does not need vite installed, and a build that never loads a native
// addon does not need the `postinstall` that fetched one.
//
// This measures the difference. For each project it reports how much of
// `node_modules` the runtime dependency closure actually is, and which
// lifecycle scripts fall inside that closure rather than in devDependencies.
//
// It exists because the same measurement on a single fixture (React) came back
// "0 hooks that matter" — and generalising from one fixture is a mistake this
// exploration has already made twice. Numbers from one project are an anecdote.
//
//   node bench/install-shape.mjs <projectDir> [projectDir...]
//   node bench/install-shape.mjs --json <projectDir>

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Scripts npm runs when installing a package **from the registry**.
 *
 * Deliberately excludes `prepare` and `prepublish`. `prepublish` does not run
 * on install at all; `prepare` runs for git dependencies, for `file:` installs
 * and for the root project — never for a published tarball, which is what a
 * host-side fetch would be unpacking. Counting them inflates the blocker: the
 * React fixture's three "hooks" were `csstype` (prepublish), `rollup`
 * (prepare) and `esbuild` (postinstall), and only the last one runs.
 */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall']

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Every installed package directory, including scoped ones. */
async function listInstalledPackages(nodeModules) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(nodeModules, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin' || e.name === '.cache') continue
    if (e.name.startsWith('@')) {
      const scoped = await fs.readdir(path.join(nodeModules, e.name), {
        withFileTypes: true,
      })
      for (const s of scoped) {
        if (s.isDirectory()) out.push(`${e.name}/${s.name}`)
      }
    } else {
      out.push(e.name)
    }
    // Nested node_modules (a version conflict npm could not hoist).
    const nested = path.join(nodeModules, e.name, 'node_modules')
    if (await exists(nested)) {
      for (const n of await listInstalledPackages(nested)) {
        out.push(`${e.name}/node_modules/${n}`)
      }
    }
  }
  return out
}

/**
 * Resolve a dependency the way a hoisted `node_modules` lays it out: prefer the
 * package's own nested copy, else walk up to the project root.
 */
async function resolvePackageDir(name, fromDir, rootDir) {
  let current = fromDir
  for (;;) {
    const candidate = path.join(current, 'node_modules', name)
    if (await exists(path.join(candidate, 'package.json'))) return candidate
    if (current === rootDir) return null
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * The packages an interception build could actually reach: the root's
 * `dependencies` (not devDependencies — it never runs the project's vite) and
 * everything those depend on transitively.
 *
 * `optionalDependencies` are included because they are importable when present.
 * `peerDependencies` are not walked: they are satisfied from the root, so they
 * are already in this set if the project uses them — and counted nowhere if it
 * does not, which is the correct answer.
 *
 * **What this deliberately does not cover.** A build with real plugin support
 * would need more than the module graph: Svelte's compiler and tailwind both
 * live in devDependencies, and a build that handled `.svelte` files or utility
 * CSS would have to install them. That is the plugin-compatibility question
 * (§9 open item 2), not the install question, and mixing the two would make
 * this number look better than it is. Read "runtime closure" as *what the PoC
 * as it stands would need*, not *what a finished tool would need*.
 */
async function runtimeClosure(rootDir) {
  const seen = new Map()

  async function walk(dir, isRoot) {
    const pkg = await readJson(path.join(dir, 'package.json'))
    if (!pkg) return
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    }
    // The root's devDependencies are deliberately skipped, not merged.
    for (const name of Object.keys(deps)) {
      const depDir = await resolvePackageDir(name, dir, rootDir)
      if (!depDir || seen.has(depDir)) continue
      seen.set(depDir, name)
      await walk(depDir, false)
    }
    void isRoot
  }

  await walk(rootDir, true)
  return seen
}

/**
 * @param skipNested Do not descend into a package's own `node_modules`. Needed
 *   when sizing one package: npm nests a copy whenever it cannot hoist, and
 *   that copy is a separate closure member with its own entry — counting it
 *   here as well would report it twice.
 */
async function dirSize(dir, skipNested = false) {
  let total = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (skipNested && e.name === 'node_modules') continue
        stack.push(full)
      } else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size
          files++
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }
  return { bytes: total, files }
}

/**
 * Extensions that cannot be a JavaScript module. Mirrors `worthSending` in
 * `poc/vite-build-intercept/run.mjs`, so the "sendable" column is the amount
 * `/api/bulk` would actually put on the wire rather than the raw closure size.
 */
const UNIMPORTABLE_EXTENSIONS = new Set([
  '.map',
  '.md',
  '.markdown',
  '.flow',
  '.node',
])

async function isSendable(full) {
  const base = path.basename(full)
  if (/\.d\.[cm]?ts$/.test(base)) return false
  const ext = path.extname(base)
  if (UNIMPORTABLE_EXTENSIONS.has(ext)) return false
  if (ext !== '') return true
  let handle
  try {
    handle = await fs.open(full, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(1024),
      0,
      1024,
      0
    )
    return !buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return true
  } finally {
    await handle?.close()
  }
}

/** Bytes of a package that would survive the bulk filter. */
async function sendableSize(dir) {
  let total = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        stack.push(full)
      } else if (e.isFile() && (await isSendable(full))) {
        try {
          total += (await fs.stat(full)).size
          files++
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }
  return { bytes: total, files }
}

async function analyse(projectDir) {
  const root = path.resolve(projectDir)
  const nodeModules = path.join(root, 'node_modules')
  if (!(await exists(nodeModules))) {
    throw new Error(`no node_modules in ${root} — install it first`)
  }

  const installed = await listInstalledPackages(nodeModules)
  const closure = await runtimeClosure(root)
  const closureDirs = new Set(closure.keys())

  const hooks = []
  for (const rel of installed) {
    const dir = path.join(nodeModules, rel)
    const pkg = await readJson(path.join(dir, 'package.json'))
    if (!pkg) continue
    const scripts = pkg.scripts ?? {}
    const found = {}
    for (const h of INSTALL_HOOKS) if (scripts[h]) found[h] = scripts[h]

    // npm runs `node-gyp rebuild` implicitly when a package has binding.gyp
    // and no install script of its own — a hook that is invisible in
    // package.json and every bit as much a process.
    const implicitGyp =
      Object.keys(found).length === 0 &&
      (await exists(path.join(dir, 'binding.gyp')))
    if (implicitGyp) found.install = '(implicit) node-gyp rebuild'

    if (Object.keys(found).length === 0) continue
    hooks.push({
      name: pkg.name ?? rel,
      inRuntimeClosure: closureDirs.has(dir),
      implicitGyp,
      scripts: found,
    })
  }

  const total = await dirSize(nodeModules)
  let closureBytes = 0
  let closureFiles = 0
  let sendableBytes = 0
  let sendableFiles = 0
  for (const dir of closureDirs) {
    const s = await dirSize(dir, true)
    closureBytes += s.bytes
    closureFiles += s.files
    const sent = await sendableSize(dir)
    sendableBytes += sent.bytes
    sendableFiles += sent.files
  }

  return {
    project: path.basename(root),
    packagesInstalled: installed.length,
    runtimeClosure: {
      packages: closureDirs.size,
      bytes: closureBytes,
      files: closureFiles,
    },
    sendable: { bytes: sendableBytes, files: sendableFiles },
    nodeModules: { bytes: total.bytes, files: total.files },
    hooks,
    hooksInClosure: hooks.filter((h) => h.inRuntimeClosure),
  }
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`

function report(results) {
  console.log(
    '\n' +
      '| project'.padEnd(26) +
      '| pkgs | closure | hooks | in closure | node_modules |  closure | sendable |'
  )
  console.log(
    '| ' +
      '-'.repeat(23) +
      ' | ---- | ------- | ----- | ---------- | ------------ | -------- | -------- |'
  )
  for (const r of results) {
    console.log(
      `| ${r.project.padEnd(23)} | ${String(r.packagesInstalled).padStart(4)} | ` +
        `${String(r.runtimeClosure.packages).padStart(7)} | ` +
        `${String(r.hooks.length).padStart(5)} | ` +
        `${String(r.hooksInClosure.length).padStart(10)} | ` +
        `${mb(r.nodeModules.bytes).padStart(12)} | ` +
        `${mb(r.runtimeClosure.bytes).padStart(8)} | ` +
        `${mb(r.sendable.bytes).padStart(8)} |`
    )
  }

  console.log('\nlifecycle scripts that run when installing from the registry:')
  const byPkg = new Map()
  for (const r of results) {
    for (const h of r.hooks) {
      const key = h.name
      if (!byPkg.has(key)) byPkg.set(key, { ...h, projects: [] })
      byPkg.get(key).projects.push(r.project)
    }
  }
  if (byPkg.size === 0) {
    console.log('  (none)')
  }
  for (const [name, h] of [...byPkg].sort()) {
    const where = h.inRuntimeClosure ? 'RUNTIME CLOSURE' : 'devDeps only'
    console.log(`  ${name}  [${where}]  x${h.projects.length} project(s)`)
    for (const [hook, body] of Object.entries(h.scripts)) {
      console.log(`      ${hook}: ${String(body).slice(0, 110)}`)
    }
  }

  const anyInClosure = results.some((r) => r.hooksInClosure.length > 0)
  console.log(
    '\n' +
      (anyInClosure
        ? 'At least one runtime dependency runs a lifecycle script. Read the\n' +
          'bodies above before concluding anything: fetching a native binary an\n' +
          'interception build never loads is not the same as generating source.'
        : 'No runtime dependency in any of these projects runs a lifecycle\n' +
          'script on install. Every hook found is a devDependency — which an\n' +
          'interception build has no reason to install, because it does not run\n' +
          "the project's build tool.")
  )
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirs = args.filter((a) => !a.startsWith('--'))
if (dirs.length === 0) {
  console.error('usage: node bench/install-shape.mjs <projectDir> [more...]')
  process.exit(1)
}

const results = []
for (const d of dirs) results.push(await analyse(d))
if (asJson) console.log(JSON.stringify(results, null, 2))
else report(results)
