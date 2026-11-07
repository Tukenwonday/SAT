import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://51.84.109.28:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://51.84.109.28:3001',
        ws: true,
      },
    },
  },
});

