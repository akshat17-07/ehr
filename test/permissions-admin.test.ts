import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { PERMISSIONS } from '../src/permissions/catalog.js';
import { fakeStaffAccounts } from './fake-staff-accounts.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db, staffAccounts: fakeStaffAccounts() });

function as(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const admin = as('dev-admin', ['admin']);
const head = as('dev-head-doctor', ['head_doctor']);

describe('GET /admin/permissions', () => {
  it('gives the whole catalog with en/hi text and adminOnly, to Admin and Head Doctor', async () => {
    for (const who of [admin, head]) {
      const res = await app.request('/admin/permissions', {}, who);
      expect(res.status).toBe(200);
      const list = (await res.json()) as { key: string; adminOnly: boolean; descriptionHi: string }[];
      expect(list).toHaveLength(PERMISSIONS.length);
      expect(list.find((p) => p.key === 'user.create')).toMatchObject({ adminOnly: true });
      expect(list.find((p) => p.key === 'bill.view')).toMatchObject({ adminOnly: false, descriptionHi: expect.any(String) });
    }
    expect((await app.request('/admin/permissions', {}, as('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
