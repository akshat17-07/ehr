import { DsqlSigner } from '@aws-sdk/dsql-signer';
import pg from 'pg';
import { env, requireEnv } from '../config/env.js';

// Aurora DSQL has no stored passwords: each connection signs a short-lived IAM token.
// One connection per Lambda container is enough for this hospital's load.
let client: pg.Client | undefined;

export async function getDb(): Promise<pg.Client> {
  if (client) return client;

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
