import { spawn } from 'node:child_process'

/**
 * Hands a URL to the desktop's default browser.
 *
 * This replaces launching a browser ourselves. Puppeteer gave the host a page
 * it owned, which is what made `page.evaluate()` possible — but it also meant
 * shipping a Chrome-locating dependency, and it meant the runtime ran in a
 * profile that was ours rather than the user's. Now that the page drives itself
 * over the control channel (see {@link ../core/rpc.js}), the host does not need
 * to own the browser at all; it only needs a tab to exist at a URL.
 *
 * Opening in the user's own browser has a second effect worth naming: **the
 * OPFS cache lives in their profile**, so it persists the way any site's
 * storage does, with no profile directory of ours to manage.
 *
 * @returns `true` if the opener was spawned, `false` if it could not be. A
 *   `false` is not fatal — the caller prints the URL and waits, because a user
 *   pasting it by hand works exactly as well.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // The empty string is `start`'s window-title argument. Without it a
          // quoted URL would be taken as the title and nothing would open.
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  return await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }

    try {
      const child = spawn(command as string, args as string[], {
        // Detached and unreferenced so the browser outlives this process —
        // `wc-exe build` exiting must not take the user's tab with it.
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => done(false))
      child.unref()
      // No exit code to wait on: `open` and `xdg-open` return immediately and
      // say nothing useful about whether a tab appeared. A spawn that did not
      // error is as much as can be known here.
      setTimeout(() => done(true), 100).unref()
    } catch {
      done(false)
    }
  })
}
