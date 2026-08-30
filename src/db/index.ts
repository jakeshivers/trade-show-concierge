import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import * as schema from './schema';

/**
 * Database client.
 *
 * Local development runs PGlite — embedded Postgres, no Docker, no accounts. The
 * schema is `pg-core`, so moving to a hosted Postgres later is a driver swap and
 * nothing more. See SCOPE.md §2.
 *
 * Lazy initialization, and deliberately NOT a Proxy wrapper: libraries that inspect
 * the client object (auth adapters especially) break when a Proxy intercepts their
 * property checks.
 */

export const DB_PATH = process.env.PGLITE_PATH ?? './.pglite';

type Database = ReturnType<typeof createDb>;

function createDb() {
  const client = new PGlite(DB_PATH);
  return drizzlePglite(client, { schema, casing: 'snake_case' });
}

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) _db = createDb();
  return _db;
}

export { schema };
