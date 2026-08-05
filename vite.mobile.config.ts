import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(process.cwd(), 'mobile'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), 'native-shell'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
})
