import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  server: {
    proxy: {
      '/healthz': 'http://127.0.0.1:8787',
      '/api': {
        target: 'http://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.tsx'],
  },
})
