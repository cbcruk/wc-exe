// Fixture for the dependency-resolution shapes docs/virtual-filesystem.md lists
// as untested. Every import below has a `node` variant and a `browser` variant;
// a browser build must pick the browser one, and the built bundle is checked
// for the winning marker AND against the losing one (resolution-expectations
// .json). Getting it wrong is silent otherwise — the build still succeeds, it
// just ships the wrong file.
import './style.css'
import { setupCounter } from './counter'

// 1. legacy `browser` field, string form — replaces `main` wholesale
import { browserString } from 'pkg-browser-string'
// 2. legacy `browser` field, object form — remaps one file to another
import { browserMap } from 'pkg-browser-map'
// 3. `imports` field: the package resolves its own `#internal` by condition
import { subpathImports } from 'pkg-subpath-imports'
// 4. `exports` wildcard spanning more than one path segment
import { deepExports } from 'pkg-deep-exports/features/alpha/beta'

const resolved: string[] = [
  browserString,
  browserMap,
  subpathImports,
  deepExports,
]

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="container">
    <h1>Sample Exports App</h1>
    <button id="counter" type="button"></button>
    <ul id="resolved">${resolved.map((r) => `<li>${r}</li>`).join('')}</ul>
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)
