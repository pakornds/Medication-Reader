import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), 'MEDREC_API_').MEDREC_API_TARGET || 'http://127.0.0.1:8000'
  return {
    plugins: [react(), tailwindcss()],
    server: {
      fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
      proxy: Object.fromEntries(['/admissions', '/imports', '/checks', '/regimens/parse', '/medication-analysis', '/pill-candidates'].map(path => [path, target])),
    },
  }
})
