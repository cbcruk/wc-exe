import './style.css'
import { setupCounter } from './counter'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="container">
    <h1>Sample Preload App</h1>
    <button id="counter" type="button"></button>
    <button id="lazy" type="button">load A</button>
    <button id="lazy-b" type="button">load B</button>
    <p id="lazy-out"></p>
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

const out = document.querySelector<HTMLParagraphElement>('#lazy-out')!

// Two dynamic imports whose targets both statically import ./shared. That makes
// the bundler hoist `shared` into its own chunk, so loading feature A means
// fetching A, parsing it, discovering `shared`, then fetching that — the
// request waterfall a __vitePreload equivalent is supposed to remove.
document
  .querySelector<HTMLButtonElement>('#lazy')!
  .addEventListener('click', async () => {
    const { featureA } = await import('./featureA')
    out.textContent = featureA()
  })

document
  .querySelector<HTMLButtonElement>('#lazy-b')!
  .addEventListener('click', async () => {
    const { featureB } = await import('./featureB')
    out.textContent = featureB()
  })
