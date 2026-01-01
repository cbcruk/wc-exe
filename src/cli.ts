import { Command } from 'commander'
import { build } from './commands/build.js'
import { dev } from './commands/dev.js'
import { install } from './commands/install.js'

const program = new Command()

program
  .name('wc-build')
  .description('WebContainer-based headless build tool for frontend projects')
  .version('0.1.0')

program
  .command('build', { isDefault: true })
  .description('Build the project using WebContainer')
  .option('-s, --source <path>', 'Source directory', '.')
  .option('-o, --output <path>', 'Output directory', './dist')
  .option('-d, --dist-dir <path>', 'Dist directory in WebContainer', '/dist')
  .option('-t, --timeout <ms>', 'Timeout for npm commands (ms)', '600000')
  .option('--no-timeout', 'Disable timeout for npm commands')
  .option('--no-install', 'Skip npm install')
  .option('--verbose', 'Show detailed logs')
  .action(async (options) => {
    try {
      await build({
        source: options.source,
        output: options.output,
        distDir: options.distDir,
        timeout:
          options.timeout === false ? undefined : parseInt(options.timeout, 10),
        noInstall: !options.install,
        verbose: options.verbose,
      })
    } catch (error) {
      console.error('\nBuild failed:', (error as Error).message)
      process.exit(1)
    }
  })

program
  .command('dev')
  .description('Start development server in WebContainer')
  .option('-p, --port <number>', 'Preview port', '5173')
  .option('--open', 'Open browser automatically')
  .action(async (options) => {
    try {
      await dev({
        port: parseInt(options.port, 10),
        open: options.open,
      })
    } catch (error) {
      console.error('\nDev server failed:', (error as Error).message)
      process.exit(1)
    }
  })

program
  .command('install')
  .description('Install dependencies only')
  .option('--cache', 'Use cached node_modules')
  .action(async (options) => {
    try {
      await install({
        cache: options.cache,
      })
    } catch (error) {
      console.error('\nInstall failed:', (error as Error).message)
      process.exit(1)
    }
  })

program.parse()
