import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The renderer is a plain web app. It never touches Node or Electron APIs
// directly: everything goes through the `window.pixel` bridge in src/api.ts.
export default defineConfig({
  plugins: [react()],
  // Relative base so the built bundle loads over file:// inside Electron.
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
