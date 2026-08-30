import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // PGlite is an embedded single-writer Postgres: two workers opening the
    // same .pglite directory corrupt each other. The suite is fast enough that
    // serial files cost nothing worth having.
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
});
