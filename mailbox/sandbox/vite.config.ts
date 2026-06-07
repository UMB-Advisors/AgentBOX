import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Sandbox proxies /ollama/* to a local Ollama instance (workstation GTX 1070).
// Sandbox runs in isolation — no traffic to M1 or M2. Pull qwen3:4b locally
// with `ollama pull qwen3:4b`. Override with OLLAMA_TARGET=http://other:11434
// when you start `pnpm dev` if you want to point elsewhere.
const OLLAMA_TARGET = process.env.OLLAMA_TARGET ?? 'http://127.0.0.1:11434'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/ollama': {
        target: OLLAMA_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
        // qwen3:4b cold-loads in ~5s and a redraft itself can take 8-15s on
        // the Jetson. Give n8n / dashboard parity (60s).
        timeout: 60_000,
      },
    },
  },
})
