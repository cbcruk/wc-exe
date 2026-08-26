import { Command } from 'commander'
import { build } from './commands/build.js'
import { dev } from './commands/dev.js'
import { install } from './commands/install.js'
import { daemonBuild } from './commands/daemon-build.js'
import { daemonStatus, stopDaemon } from './daemon/client.js'

const program = new Command()

program
  .name('wc-exe')
  .description(
    'WebContainer Executor - Headless build tool for frontend projects'
  )
  .version('0.1.1')

program
  .command('build', { isDefault: true })
  .description('Build the project using WebContainer')
  .option('-s, --source <path>', 'Source directory', '.')
  .option('-o, --output <path>', 'Output directory', './dist')
  .option('-d, --dist-dir <path>', 'Dist directory in WebContainer', '/dist')
  .option('-t, --timeout <ms>', 'Timeout for npm commands (ms)', '600000')
  .option('--no-timeout', 'Disable timeout for npm commands')
  .option('--no-install', 'Skip npm install')
  .option(
    '--cache',
    'Cache node_modules in OPFS and reuse when the lockfile is unchanged'
  )
  .option('--verbose', 'Show detailed logs')
  .option(
    '--no-open',
    'Do not open the runner page; print its URL and wait for you to open it'
  )
  .option(
    '--daemon',
    'Build through a background daemon that keeps the runtime booted'
  )
  .option('--fresh', 'With --daemon, discard any existing session first')
  .action(async (options) => {
    try {
      if (options.daemon) {
        await daemonBuild({
          source: options.source,
          output: options.output,
          distDir: options.distDir,
          timeout:
            options.timeout === false
              ? undefined
              : parseInt(options.timeout, 10),
          noInstall: !options.install,
          verbose: options.verbose,
          fresh: options.fresh,
        })
        return
      }

      await build({
        source: options.source,
        output: options.output,
        distDir: options.distDir,
        timeout:
          options.timeout === false ? undefined : parseInt(options.timeout, 10),
        noInstall: !options.install,
        cache: options.cache,
        verbose: options.verbose,
        open: options.open,
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
  .option(
    '--no-open',
    'Do not open the runner page; print its URL and wait for you to open it'
  )
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
  .option(
    '--no-open',
    'Do not open the runner page; print its URL and wait for you to open it'
  )
  .action(async (options) => {
    try {
      await install({
        cache: options.cache,
        open: options.open,
      })
    } catch (error) {
      console.error('\nInstall failed:', (error as Error).message)
      process.exit(1)
    }
  })

const daemon = program
  .command('daemon')
  .description('Manage the background daemon')

daemon
  .command('status')
  .description('Show the running daemon, if any')
  .action(async () => {
    const running = await daemonStatus()
    if (!running) {
      console.log('No daemon is running.')
      return
    }

    const { record, health } = running
    console.log(`pid       ${health.pid}`)
    console.log(`port      ${record.port}`)
    console.log(`version   ${health.version}`)
    console.log(`uptime    ${(health.uptimeMs / 1000).toFixed(0)}s`)
    console.log(`idle-out  ${(health.idleMs / 1000).toFixed(0)}s`)
    console.log(`sessions  ${health.sessions.length}`)
    for (const session of health.sessions) {
      const state = session.poisoned ? `UNUSABLE: ${session.poisoned}` : 'ok'
      console.log(`  ${session.source}  [${state}]`)
    }
  })

daemon
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    console.log(
      (await stopDaemon()) ? 'Daemon stopped.' : 'No daemon was running.'
    )
  })

daemon
  .command('restart')
  .description('Stop the running daemon; the next build starts a fresh one')
  .action(async () => {
    await stopDaemon()
    console.log('Daemon stopped. The next build will start a new one.')
  })

program.parse()
