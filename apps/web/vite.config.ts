import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command, isPreview }) => {
  const defaultTarget = 'http://127.0.0.1:8787'
  const target = command === 'serve' && !isPreview
    ? process.env.DROPIT_DEV_BACKEND_ORIGIN?.trim() || defaultTarget
    : defaultTarget

  return {
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        '@': path.resolve(root, 'src'),
      },
    },
    server: {
      proxy: {
        '/healthz': target,
        '/d/': target,
        '/api': {
          target,
          ws: true,
        },
      },
    },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.tsx'],
      setupFiles: ['src/test-setup.ts'],
    },
  }
})
