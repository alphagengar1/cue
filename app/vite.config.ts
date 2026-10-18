import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // relative asset paths for the Even Hub package
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
