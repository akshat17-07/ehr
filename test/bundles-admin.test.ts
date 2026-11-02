import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { BUILT_IN_BUNDLES } from '../src/permissions/bundles.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);

describe('GET /admin/bundles', () => {
  it('lists the bundles by name for Admin and Head Doctor', async () => {
    for (const who of [admin, head]) {
      const res = await app.request('/admin/bundles', {}, who);
      expect(res.status).toBe(200);
      const bundles = (await res.json()) as { name: string; permissions: string[]; builtIn: boolean }[];
      expect(bundles.map((b) => b.name)).toEqual(['billing', 'health_data', 'reception', 'records', 'store', 'tpa']);
      expect(bundles.find((b) => b.name === 'tpa')).toMatchObject({ builtIn: true, permissions: [...BUILT_IN_BUNDLES.tpa] });
    }
  });

  it('403 for a doctor (not a management group)', async () => {
    expect((await app.request('/admin/bundles', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
