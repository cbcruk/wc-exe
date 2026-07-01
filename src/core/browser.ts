import puppeteer, { type Browser, type Page } from 'puppeteer-core'

export class WCBrowser {
  private browser: Browser | null = null
  private page: Page | null = null
  private verbose: boolean = false

  constructor(options?: { verbose?: boolean }) {
    this.verbose = options?.verbose ?? false
  }

  async launch(serverUrl: string): Promise<void> {
    const executablePath = await this.findChrome()

    this.browser = await puppeteer.launch({
      headless: true,
      executablePath,
      protocolTimeout: 600000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    })

    this.page = await this.browser.newPage()

    if (this.verbose) {
      this.page.on('console', (msg) => {
        console.log('[Browser]', msg.text())
      })

      this.page.on('response', (response) => {
        if (!response.ok()) {
          console.log('[Browser 404]', response.url(), response.status())
        }
      })
    }

    this.page.on('pageerror', (err) => {
      console.error('[Browser Error]', err.message)
    })

    await this.page.goto(serverUrl)

    await this.page.waitForFunction(
      () =>
        (window as unknown as { __WC_READY__?: boolean }).__WC_READY__ === true,
      { timeout: 60000 }
    )
  }

  private async findChrome(): Promise<string> {
    const { access } = await import('node:fs/promises')

    const envPath = process.env.CHROME_PATH
    if (envPath) {
      try {
        await access(envPath)
        return envPath
      } catch {
        throw new Error(`CHROME_PATH is set but not accessible: ${envPath}`)
      }
    }

    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]

    for (const chromePath of paths) {
      try {
        await access(chromePath)
        return chromePath
      } catch {
        continue
      }
    }

    throw new Error(
      'Chrome not found. Please install Chrome or set CHROME_PATH environment variable.'
    )
  }

  async mountFromServer(): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async () => {
      return await (
        window as unknown as {
          wcRunner: { mountFromServer: () => Promise<number> }
        }
      ).wcRunner.mountFromServer()
    })
  }

  async runCommand(
    cmd: string,
    args: string[],
    timeout?: number
  ): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    const commandPromise = this.page.evaluate(
      async (cmdArg: string, argsArg: string[]) => {
        return await (
          window as unknown as {
            wcRunner: {
              runCommand: (c: string, a: string[]) => Promise<number>
            }
          }
        ).wcRunner.runCommand(cmdArg, argsArg)
      },
      cmd,
      args
    )

    if (!timeout) {
      return commandPromise
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Command timed out after ${timeout}ms: ${cmd} ${args.join(' ')}`
          )
        )
      }, timeout)
    })

    return Promise.race([commandPromise, timeoutPromise])
  }

  async uploadDist(distPath: string = '/dist'): Promise<number> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async (pathArg: string) => {
      return await (
        window as unknown as {
          wcRunner: { uploadDist: (p: string) => Promise<number> }
        }
      ).wcRunner.uploadDist(pathArg)
    }, distPath)
  }

  async spawnCommand(cmd: string, args: string[]): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(
      (cmdArg: string, argsArg: string[]) => {
        ;(
          window as unknown as {
            wcRunner: {
              spawnCommand: (c: string, a: string[]) => void
            }
          }
        ).wcRunner.spawnCommand(cmdArg, argsArg)
      },
      cmd,
      args
    )
  }

  async waitForServerReady(): Promise<{ port: number; url: string }> {
    if (!this.page) throw new Error('Browser not launched')

    return await this.page.evaluate(async () => {
      return await (
        window as unknown as {
          wcRunner: {
            getServerUrl: () => Promise<{ port: number; url: string }>
          }
        }
      ).wcRunner.getServerUrl()
    })
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    await this.page.evaluate(
      async (pathArg: string, contentArg: string) => {
        await (
          window as unknown as {
            wcRunner: {
              writeFile: (p: string, c: string) => Promise<void>
            }
          }
        ).wcRunner.writeFile(pathArg, contentArg)
      },
      path,
      content
    )
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = null
    this.page = null
  }
}
