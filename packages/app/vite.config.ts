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
    // Pin to IPv4 loopback: on Node 17+ `localhost` resolves to `::1` first,
    // which would leave the dev launcher's 127.0.0.1 readiness probe (and
    // Electron's load) pointing at a socket nothing is listening on.
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
});
