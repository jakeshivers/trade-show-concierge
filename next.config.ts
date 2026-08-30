import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships WASM and must not be bundled by the server compiler.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default nextConfig;
