import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '[::1]', 'localhost'])

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), 'MEDREC_')
  const target = env.MEDREC_API_TARGET || 'http://127.0.0.1:8000'
  const demo = command === 'serve' && !isPreview && loopback.has(new URL(target).hostname)
    && Boolean(env.MEDREC_DEMO_PHARMACIST_TOKEN)
  const staffProxy: ProxyOptions = {
    target,
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, request) => {
        if (!demo || !loopback.has(request.socket.remoteAddress ?? '')) return
        if (request.headers['sec-fetch-site'] === 'cross-site') return
        const host = request.headers.host
        if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return
        const origin = request.headers.origin
        if (origin && origin !== 'http://' + host && origin !== 'https://' + host) return
        outgoing.setHeader('X-Demo-Reviewer-Token', env.MEDREC_DEMO_PHARMACIST_TOKEN)
      })
    },
  }
  return {
    plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.MEDREC_LOCAL_DEMO': JSON.stringify(demo) },
    server: {
      fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
      proxy: {
        '/admissions': staffProxy, '/imports': staffProxy, '/checks': staffProxy,
        '/regimens/parse': target, '/medication-analysis': target, '/pill-candidates': target,
      },
    },
  }
})
