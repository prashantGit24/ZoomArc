import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // Icon/binary assets and packaged output live under these — Vite has no
    // reason to watch them, and on Windows a fresh write there can crash the
    // watcher outright (EBUSY on the just-created file).
    watch: { ignored: ['**/build/**', '**/release/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Second entry: the hidden window that renders export frames.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        export: resolve(__dirname, 'export.html'),
      },
    },
  },
})
