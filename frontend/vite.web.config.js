import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Website build of the Clip Trimmer and Vocal Remover ("SyncWave Online").
// Output goes to dist-web/; scripts/build-web.sh publishes it as
// "Marketing Website/app/" with the AI models and engines next to it.
export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: 'web-public',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: { input: 'web.html' },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
})
