import fs from 'node:fs/promises'
import path from 'node:path'

// Directory names never mounted into the runtime: they are either regenerated
// there (node_modules, build output) or irrelevant to a build.
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

/**
 * Recursively lists the files under `sourcePath`, skipping build and VCS
 * directories ({@link IGNORE_PATTERNS}).
 *
 * @param sourcePath Directory to walk.
 * @param basePath Prefix for the returned paths. Used by the recursion; callers
 *   normally leave it empty to get paths relative to `sourcePath`.
 * @returns Slash-separated relative paths, in no particular order.
 */
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

/**
 * Reads one project file as raw bytes.
 *
 * @param sourcePath Directory `relPath` is resolved against.
 * @param relPath Slash-separated path relative to `sourcePath`.
 * @throws If `relPath` resolves outside `sourcePath`.
 */
export async function readProjectFileBytes(
  sourcePath: string,
  relPath: string
): Promise<Uint8Array> {
  return fs.readFile(safeResolve(sourcePath, relPath))
}

/**
 * Empties the output directory and recreates it, so a build never mixes
 * artifacts with those of a previous run.
 *
 * @param outputPath Directory to reset. **Deleted recursively.**
 */
export async function prepareOutputDir(outputPath: string): Promise<void> {
  const absoluteOutput = path.resolve(outputPath)
  await fs.rm(absoluteOutput, { recursive: true, force: true })
  await fs.mkdir(absoluteOutput, { recursive: true })
}

/**
 * Writes one build artifact, creating parent directories as needed.
 *
 * @param outputPath Directory `relPath` is resolved against.
 * @param relPath Slash-separated path relative to `outputPath`.
 * @param data File contents.
 * @throws If `relPath` resolves outside `outputPath`.
 */
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
