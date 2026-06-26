import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias @xyflow/* to SOURCE so edits to packages/* are picked up live (no build).
// Transitive deps (zustand, d3-*, classcat) resolve from each package's own
// node_modules because the source files live under packages/*/src.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@xyflow/react': r('../../packages/react/src/index.ts'),
      '@xyflow/system': r('../../packages/system/src/index.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 4320, fs: { allow: [r('../..')] } },
});
