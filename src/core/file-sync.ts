import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileSystemTree, FileNode, DirectoryNode } from '../types.js'

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

export async function readProjectFiles(
  sourcePath: string,
  basePath: string = ''
): Promise<FileSystemTree> {
  const result: FileSystemTree = {}
  const absolutePath = path.resolve(sourcePath)
  const entries = await fs.readdir(absolutePath, { withFileTypes: true })

  for (const entry of entries) {
    if (IGNORE_PATTERNS.includes(entry.name)) {
      continue
    }

    const fullPath = path.join(absolutePath, entry.name)

    if (entry.isDirectory()) {
      const subTree = await readProjectFiles(
        fullPath,
        path.join(basePath, entry.name)
      )

      result[entry.name] = { directory: subTree } as DirectoryNode
    } else if (entry.isFile()) {
      const content = await fs.readFile(fullPath)
      const isBinary = isBinaryFile(entry.name, content)

      result[entry.name] = {
        file: {
          contents: isBinary ? content : content.toString('utf-8'),
        },
      } as FileNode
    }
  }

  return result
}

function isBinaryFile(filename: string, content: Buffer): boolean {
  const binaryExtensions = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.webp',
    '.avif',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.otf',
    '.zip',
    '.tar',
    '.gz',
    '.br',
    '.pdf',
    '.doc',
    '.docx',
    '.mp3',
    '.mp4',
    '.webm',
    '.ogg',
  ]

  const ext = path.extname(filename).toLowerCase()

  if (binaryExtensions.includes(ext)) {
    return true
  }

  for (let i = 0; i < Math.min(1024, content.length); i++) {
    if (content[i] === 0) {
      return true
    }
  }

  return false
}

export async function writeDistFiles(
  outputPath: string,
  files: Record<string, number[]>,
  distDir: string = '/dist'
): Promise<void> {
  const absoluteOutput = path.resolve(outputPath)

  await fs.rm(absoluteOutput, { recursive: true, force: true })
  await fs.mkdir(absoluteOutput, { recursive: true })

  const escapedDistDir = distDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const distDirPattern = new RegExp(`^${escapedDistDir}/?`)

  for (const [filePath, contentArray] of Object.entries(files)) {
    const relativePath = filePath.replace(distDirPattern, '')
    const fullPath = path.join(absoluteOutput, relativePath)
    const dir = path.dirname(fullPath)

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(fullPath, Buffer.from(contentArray))
  }
}
