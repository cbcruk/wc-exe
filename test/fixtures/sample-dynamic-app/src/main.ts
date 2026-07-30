import './style.css'
import { setupCounter } from './counter'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="container">
    <h1>Sample Dynamic App</h1>
    <button id="counter" type="button"></button>
    <button id="lazy" type="button">load lazy</button>
    <p id="lazy-out"></p>
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

// Dynamic import: must land in its own chunk, fetched only on click.
document
  .querySelector<HTMLButtonElement>('#lazy')!
  .addEventListener('click', async () => {
    const { lazyMessage } = await import('./lazy')
    document.querySelector<HTMLParagraphElement>('#lazy-out')!.textContent =
      lazyMessage()
  })
