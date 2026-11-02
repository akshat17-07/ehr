import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';
import { createGrant, revokeGrant } from '../src/permissions/grants.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const headId = seedId('a0000000', 2);
const doctorId = seedId('a0000000', 3);
const surgeonId = seedId('a0000000', 4);

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
const give = (userId: string, permission: string, end = days(30)) =>
  createGrant(db, { userId, permission, scope: 'all', end, grantorId: 'dev-head-doctor', reason: 'cover for leave' }, days(-10));

const active = await give('dev-doctor', 'pcpndt.view');
const expired = await give('dev-doctor', 'mtp.view', days(-1));
const revoked = await revokeGrant(db, { id: (await give('dev-surgeon', 'pcpndt.view')).id, version: 1, by: 'dev-admin', reason: 'not needed' });

// Rows made in the same instant would tie on created_at: space them a minute apart, in the order made.
for (const [i, id] of [active.id, expired.id, revoked.id].entries()) {
  await db.query('UPDATE grants SET created_at = $1 WHERE id = $2', [new Date(now.getTime() + i * 60_000), id]);
}

type Page = { items: { id: string; userId: string; grantorId: string; status: string }[]; nextCursor?: string };
const list = async (query = '', who = admin) => {
  const res = await app.request(`/admin/grants${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};

describe('GET /admin/grants', () => {
  it('lists grants newest first, with users.id for the user and the grantor', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((g) => g.id)).toEqual([revoked.id, expired.id, active.id]);
    expect(body.items[2]).toMatchObject({ userId: doctorId, grantorId: headId, permission: 'pcpndt.view', status: 'active' });
  });

  it('filters by user, permission and status', async () => {
    expect((await list(`?userId=${doctorId}`)).body.items.map((g) => g.id)).toEqual([expired.id, active.id]);
    expect((await list(`?userId=${surgeonId}&status=revoked`)).body.items.map((g) => g.id)).toEqual([revoked.id]);
    expect((await list('?permission=pcpndt.view')).body.items.map((g) => g.id)).toEqual([revoked.id, active.id]);
    expect((await list('?status=active')).body.items.map((g) => g.id)).toEqual([active.id]);
    expect((await list('?status=expired')).body.items.map((g) => g.id)).toEqual([expired.id]);
    expect((await list(`?userId=${seedId('a0000000', 9)}`)).body.items).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const first = await list('?limit=2');
    expect(first.body.items).toHaveLength(2);
    const next = await list(`?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map((g) => g.id)).toEqual([active.id]);
    expect(next.body.nextCursor).toBeUndefined();
  });

  it('422 for a bad filter; 403 without grant.view', async () => {
    expect((await list('?userId=nope')).status).toBe(422);
    expect((await list('?permission=no.such')).status).toBe(422);
    expect((await list('?status=gone')).status).toBe(422);
    expect((await list('', head)).status).toBe(200);
    expect((await list('', asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
