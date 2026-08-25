// Fixture for the asset pipeline — docs/virtual-filesystem.md open item 3.
//
// vite turns an asset import into a URL and emits the file with a content hash,
// except when it is under `assetsInlineLimit` (4 KB by default), where the
// import becomes a data URI and no file is emitted. Both branches are here:
// tiny.svg is well under the limit, big.png is well over it.
import './style.css'
import { setupCounter } from './counter'
import tinyUrl from './assets/tiny.svg'
import bigUrl from './assets/big.png'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="container">
    <h1>Sample Asset App</h1>
    <button id="counter" type="button"></button>
    <img id="tiny" src="${tinyUrl}" width="16" height="16" alt="" />
    <img id="big" src="${bigUrl}" width="48" height="48" alt="" />
  </div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)
