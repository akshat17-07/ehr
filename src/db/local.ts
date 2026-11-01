import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, type Queryable } from './migrate.js';

// Stand-in for the API role in local databases; the IAM grant that uses it is skipped there.
export const LOCAL_ROLE_ARN = 'arn:aws:iam::000000000000:role/local-api';

export interface LocalDb extends Queryable {
  close(): Promise<void>;
}

/**
 * Real Postgres (PGlite, compiled to WebAssembly) for `npm run dev` and tests: no Docker, no AWS.
 * In memory when `dataDir` is undefined, otherwise kept in that folder. All migrations are applied.
 * Never used in AWS: PGlite is a dev dependency and is left out of the Lambda bundle.
 */
export async function openLocalDb(dataDir?: string): Promise<LocalDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true }); // PGlite creates the folder, not its parents
  const db = new PGlite(dataDir);
  await migrate(db, { apiRoleArn: LOCAL_ROLE_ARN, dialect: 'postgres' });
  return db;
}
