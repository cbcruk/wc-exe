import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts', 'src/daemon/daemon-entry.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
