import { DsqlSigner } from '@aws-sdk/dsql-signer';
import pg from 'pg';
import { env, requireEnv } from '../config/env.js';
import { openLocalDb } from './local.js';
import type { Queryable } from './migrate.js';

// Aurora DSQL has no stored passwords: each connection signs a short-lived IAM token.
// One connection per Lambda container is enough for this hospital's load.
let client: Queryable | undefined;

/** Aurora DSQL in AWS. Locally (no DSQL_ENDPOINT, not production): the embedded Postgres in LOCAL_DB_DIR. */
export async function getDb(): Promise<Queryable> {
  if (client) return client;
  if (!env.DSQL_ENDPOINT && env.NODE_ENV !== 'production') {
    client = await openLocalDb(env.LOCAL_DB_DIR);
    return client;
  }

  const host = requireEnv('DSQL_ENDPOINT');
  const signer = new DsqlSigner({ hostname: host, region: env.AWS_REGION });
  const password =
    env.DB_USER === 'admin' ? await signer.getDbConnectAdminAuthToken() : await signer.getDbConnectAuthToken();

  const c = new pg.Client({
    host,
    port: 5432,
    database: 'postgres',
    user: env.DB_USER,
    password,
    ssl: { rejectUnauthorized: true },
  });
  const reset = () => {
    client = undefined;
  };
  c.on('error', reset);
  c.on('end', reset);

  await c.connect();
  client = c;
  return c;
}
