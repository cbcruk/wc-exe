import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import invariant from 'tiny-invariant'

const ANSI_REGEX =
  /* eslint-disable-next-line no-control-regex */
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

const SPINNER_CHARS = [
  '\\',
  '|',
  '/',
  '-',
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]

function filterOutput(chunk: string): string | null {
  const cleaned = chunk.replace(ANSI_REGEX, '').trim()

  if (!cleaned) return null

  if (SPINNER_CHARS.includes(cleaned)) return null

  return chunk
}

declare global {
  interface Window {
    __WC_READY__: boolean
    wcRunner: typeof wcRunner
  }
}

let webcontainer: WebContainer | null = null

async function boot(): Promise<WebContainer> {
  console.log('[wc-build] Booting WebContainer...')
  webcontainer = await WebContainer.boot()
  console.log('[wc-build] WebContainer ready!')
  window.__WC_READY__ = true
  return webcontainer
}

async function mountFromServer(): Promise<number> {
  invariant(webcontainer, 'WebContainer not booted')

  const manifestRes = await fetch('/api/files')
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch file manifest: ${manifestRes.status}`)
  }

  const paths: string[] = await manifestRes.json()

  console.log(`[wc-build] Fetching ${paths.length} files...`)

  const tree: FileSystemTree = {}

  for (const filePath of paths) {
    const fileRes = await fetch(
      `/api/files/raw?path=${encodeURIComponent(filePath)}`
    )
    if (!fileRes.ok) {
      throw new Error(`Failed to fetch file ${filePath}: ${fileRes.status}`)
    }

    const contents = new Uint8Array(await fileRes.arrayBuffer())
    insertIntoTree(tree, filePath, contents)
  }

  await webcontainer.mount(tree)

  console.log(`[wc-build] Mounted ${paths.length} files.`)

  return paths.length
}

function insertIntoTree(
  tree: FileSystemTree,
  filePath: string,
  contents: Uint8Array
): void {
  const parts = filePath.split('/').filter(Boolean)
  let node = tree

  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i]
    const existing = node[dir]

    if (!existing) {
      const child: FileSystemTree = {}
      node[dir] = { directory: child }
      node = child
    } else if ('directory' in existing) {
      node = existing.directory
    } else {
      throw new Error(`Path conflict: ${dir} is a file, expected a directory`)
    }
  }

  node[parts[parts.length - 1]] = { file: { contents } }
}

async function runCommand(cmd: string, args: string[]): Promise<number> {
  invariant(webcontainer, 'WebContainer not booted')

  console.log(`[wc-build] Running: ${cmd} ${args.join(' ')}`)

  const process = await webcontainer.spawn(cmd, args)

  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        const filtered = filterOutput(chunk)
        if (filtered) console.log(filtered)
      },
    })
  )

  const exitCode = await process.exit

  if (exitCode === 0) {
    console.log(`[wc-build] Command exited with code: ${exitCode}`)
  } else {
    console.error(`[wc-build] Command exited with code: ${exitCode}`)
  }

  return exitCode
}

function spawnCommand(cmd: string, args: string[]): void {
  invariant(webcontainer, 'WebContainer not booted')

  console.log(`[wc-build] Spawning: ${cmd} ${args.join(' ')}`)

  webcontainer.spawn(cmd, args).then((process) => {
    process.output.pipeTo(
      new WritableStream({
        write(chunk) {
          const filtered = filterOutput(chunk)
          if (filtered) console.log(filtered)
        },
      })
    )
  })
}

async function writeFile(path: string, content: string): Promise<void> {
  invariant(webcontainer, 'WebContainer not booted')

  await webcontainer.fs.writeFile(path, content)

  console.log(`[wc-build] File written: ${path}`)
}

async function uploadDist(distPath: string): Promise<number> {
  invariant(webcontainer, 'WebContainer not booted')

  const wc = webcontainer
  let count = 0

  async function traverse(currentPath: string): Promise<void> {
    const entries = await wc.fs.readdir(currentPath, {
      withFileTypes: true,
    })

    for (const entry of entries) {
      const fullPath =
        currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`

      if (entry.isDirectory()) {
        await traverse(fullPath)
      } else {
        const content = await wc.fs.readFile(fullPath)
        const relative = fullPath.slice(distPath.length).replace(/^\//, '')
        const body = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength
        ) as ArrayBuffer

        const res = await fetch(
          `/api/dist?path=${encodeURIComponent(relative)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          }
        )

        if (!res.ok) {
          throw new Error(`Failed to upload ${relative}: ${res.status}`)
        }

        count++
      }
    }
  }

  await traverse(distPath)

  console.log(`[wc-build] Uploaded ${count} dist files.`)

  return count
}

async function getServerUrl(): Promise<{ port: number; url: string }> {
  invariant(webcontainer, 'WebContainer not booted')

  const wc = webcontainer

  return new Promise((resolve) => {
    let resolved = false

    wc.on('server-ready', (port, url) => {
      if (resolved) return
      resolved = true
      console.log(`[wc-build] Server ready at ${url}`)
      resolve({ port, url })
    })
  })
}

const wcRunner = {
  boot,
  mountFromServer,
  runCommand,
  spawnCommand,
  writeFile,
  uploadDist,
  getServerUrl,
}

window.wcRunner = wcRunner

boot().catch((err) => {
  console.error(`[wc-build] Boot failed: ${err.message}`)
})
