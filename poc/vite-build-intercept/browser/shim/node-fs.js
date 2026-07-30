// Minimal `node:fs` stand-in for the browser, wired up through the page's
// import map.
//
// @rolldown/browser's shared option-normalizing chunk statically imports
// `node:fs` (and `node:url`) even in its browser entry, so the bare specifier
// has to resolve to something. It is only reached when rolldown loads a config
// file from disk; this PoC always passes options inline, so nothing here should
// ever run. It therefore throws loudly rather than pretending to succeed — a
// silent empty read would surface later as a confusing bundling error.

function unavailable(name) {
  return () => {
    throw new Error(
      `node:fs.${name} is not available in the browser ` +
        `(the bundler tried to touch the real filesystem; the PoC passes ` +
        `options inline, so this indicates an unexpected code path)`
    )
  }
}

export const readFileSync = unavailable('readFileSync')
export const existsSync = () => false
export const statSync = unavailable('statSync')
export const writeFileSync = unavailable('writeFileSync')

export default { readFileSync, existsSync, statSync, writeFileSync }
