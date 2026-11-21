// Local proxy for the synthetic browser fixture, so Chromium sends original file bytes.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export default {
  cacheDir: join(tmpdir(), 'medication-reader-intake-vite'),
  server: { proxy: process.env.INTAKE_API_ORIGIN ? {
    '/fixture-api': { target: process.env.INTAKE_API_ORIGIN, rewrite: path => path.replace(/^\/fixture-api/, '') },
  } : undefined },
}
