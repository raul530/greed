import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { parseAllowedHosts } from '../server/net'

// Os mesmos GREED_HOST/GREED_ALLOWED_HOSTS do servidor valem pro dev server:
// o vite escuta no mesmo endereço e aceita os mesmos nomes de Host. O proxy
// aponta pro backend onde quer que ele tenha subido (bind curinga vira loopback).
const bind = process.env.GREED_HOST?.trim() || ''
const backendHost = !bind || bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind
const backendPort = Number(process.env.GREED_PORT ?? 4517)
const backend = `${backendHost.includes(':') ? `[${backendHost}]` : backendHost}:${backendPort}`

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: bind || undefined,
    allowedHosts: parseAllowedHosts(process.env.GREED_ALLOWED_HOSTS),
    port: 5173,
    proxy: {
      '/api': `http://${backend}`,
      '/preview': `http://${backend}`,
      '/ws': { target: `ws://${backend}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
