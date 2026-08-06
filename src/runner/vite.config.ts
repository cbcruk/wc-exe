import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the page works wherever it is mounted. The daemon
  // hosts one session per path (`/s/<id>/`) on a single origin, and absolute
  // `/assets/...` links would all collapse onto the first session.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
