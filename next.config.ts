import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships WASM and must not be bundled by the server compiler.
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: {
    serverActions: {
      /**
       * An exhibitor service manual is a real PDF — tens of pages of tables and
       * artwork — and the Server Action default is 1 MB. Left alone, uploading a
       * manual fails with a body-size error that says nothing about manuals,
       * which is the worst possible version of `MAX_MANUAL_BYTES`: the app would
       * appear to refuse documents for no stated reason. The store's own limit is
       * the one that produces a sentence a person can act on, so this is set to
       * match it and the refusal is left to `lib/manual/store.ts`.
       */
      bodySizeLimit: '32mb',
    },
  },
};

export default nextConfig;
