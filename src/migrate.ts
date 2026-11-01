import { requireEnv } from './config/env.js';
import { getDb } from './db/client.js';
import { migrate } from './db/migrate.js';

// Migration Lambda (see infra/constructs/migrations.ts). Runs on every deploy, logs in as the DSQL admin.
export const handler = async () => {
  const db = await getDb();
  const applied = await migrate(db, { apiRoleArn: requireEnv('API_ROLE_ARN') });
  console.log(JSON.stringify({ msg: 'migrations done', applied }));
  return { applied };
};
