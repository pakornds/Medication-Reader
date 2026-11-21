import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/regimens/parse': 'http://127.0.0.1:8000',
      '/medication-analysis': 'http://127.0.0.1:8000',
      '/checks/local/products': 'http://127.0.0.1:8000',
    },
  },
})
