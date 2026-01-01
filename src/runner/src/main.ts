import { WebContainer } from '@webcontainer/api'
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

async function mountFiles(
  files: Parameters<WebContainer['mount']>[0]
): Promise<void> {
  invariant(webcontainer, 'WebContainer not booted')

  console.log(`[wc-build] Mounting ${Object.keys(files).length} entries...`)

  await webcontainer.mount(files)

  console.log('[wc-build] Files mounted.')
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

async function readFile(path: string): Promise<string> {
  invariant(webcontainer, 'WebContainer not booted')

  return await webcontainer.fs.readFile(path, 'utf-8')
}

async function readFileRaw(path: string): Promise<Uint8Array> {
  invariant(webcontainer, 'WebContainer not booted')

  return await webcontainer.fs.readFile(path)
}

async function readDir(path: string): Promise<string[]> {
  invariant(webcontainer, 'WebContainer not booted')

  return await webcontainer.fs.readdir(path)
}

async function readDirRecursive(
  basePath: string
): Promise<Record<string, number[]>> {
  invariant(webcontainer, 'WebContainer not booted')

  const wc = webcontainer
  const results: Record<string, number[]> = {}

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
        try {
          const content = await wc.fs.readFile(fullPath)

          results[fullPath] = Array.from(content)
        } catch {
          console.error(`[wc-build] Failed to read: ${fullPath}`)
        }
      }
    }
  }

  try {
    await traverse(basePath)
  } catch {
    console.error(`[wc-build] Directory not found: ${basePath}`)
  }

  return results
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
  mountFiles,
  runCommand,
  spawnCommand,
  writeFile,
  readFile,
  readFileRaw,
  readDir,
  readDirRecursive,
  getServerUrl,
}

window.wcRunner = wcRunner

boot().catch((err) => {
  console.error(`[wc-build] Boot failed: ${err.message}`)
})
