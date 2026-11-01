// npm run seed: puts sample users, departments and drugs in the local database (.data/db). Never in AWS.
import { env } from './config/env.js';

if (env.DSQL_ENDPOINT || env.NODE_ENV === 'production') {
  console.error('npm run seed is for the local database only (unset DSQL_ENDPOINT, not production).');
  process.exit(1);
}

const { openLocalDb } = await import('./db/local.js');
const { seedDev, DEV_USERS } = await import('./db/seed-dev.js');

const db = await openLocalDb(env.LOCAL_DB_DIR);
const count = await seedDev(db);
await db.close();
console.log(`Seeded ${count} rows into ${env.LOCAL_DB_DIR}. Dev users (header x-dev-user):`);
for (const u of DEV_USERS) console.log(`  ${u.sub}|${u.sub.replace(/^dev-/, '')}@dev.local|${u.type}`);
