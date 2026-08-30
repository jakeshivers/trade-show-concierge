import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  driver: 'pglite',
  dbCredentials: { url: process.env.PGLITE_PATH ?? './.pglite' },
  casing: 'snake_case',
  verbose: true,
  strict: false,
});
