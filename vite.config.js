import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173 },
  // Pre-bundle the deep example imports. Discovering one of these lazily makes
  // the dev server re-optimise and serve 504s for the in-flight requests, which
  // fails a headless capture that happens to boot across the reload.
  optimizeDeps: {
    include: [
      'three',
      'three/examples/jsm/loaders/HDRLoader.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
    ],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
