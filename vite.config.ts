import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': apiTarget },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
