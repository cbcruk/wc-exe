import fs from 'node:fs/promises'
import path from 'node:path'

const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.turbo',
  '.cache',
]

export async function listProjectFiles(
  sourcePath: string,
  basePath: string = ''
): Promise<string[]> {
  const absolutePath = path.resolve(sourcePath)
  const entries = await fs.readdir(absolutePath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (IGNORE_PATTERNS.includes(entry.name)) {
      continue
    }

    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      const subFiles = await listProjectFiles(
        path.join(absolutePath, entry.name),
        relativePath
      )
      files.push(...subFiles)
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files
}

export async function readProjectFileBytes(
  sourcePath: string,
  relPath: string
): Promise<Uint8Array> {
  return fs.readFile(safeResolve(sourcePath, relPath))
}

export async function prepareOutputDir(outputPath: string): Promise<void> {
  const absoluteOutput = path.resolve(outputPath)
  await fs.rm(absoluteOutput, { recursive: true, force: true })
  await fs.mkdir(absoluteOutput, { recursive: true })
}

export async function writeDistFile(
  outputPath: string,
  relPath: string,
  data: Uint8Array
): Promise<void> {
  const fullPath = safeResolve(outputPath, relPath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, data)
}

function safeResolve(base: string, relPath: string): string {
  const absoluteBase = path.resolve(base)
  const fullPath = path.resolve(absoluteBase, ...relPath.split('/'))

  if (
    fullPath !== absoluteBase &&
    !fullPath.startsWith(absoluteBase + path.sep)
  ) {
    throw new Error(`Path escapes base directory: ${relPath}`)
  }

  return fullPath
}
