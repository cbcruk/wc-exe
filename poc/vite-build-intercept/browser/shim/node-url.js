// Minimal `node:url` stand-in for the browser, wired up through the page's
// import map. @rolldown/browser only needs `fileURLToPath`.

/** Strip a file: URL down to a path, which is all the bundler asks for here. */
export function fileURLToPath(url) {
  const href = typeof url === 'string' ? url : String(url)
  return href.startsWith('file://') ? decodeURIComponent(href.slice(7)) : href
}

export function pathToFileURL(p) {
  return new URL(`file://${p}`)
}

export default { fileURLToPath, pathToFileURL }
