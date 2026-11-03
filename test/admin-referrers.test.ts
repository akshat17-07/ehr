import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const gpUser = seedId('a0000000', 10);
const reason = 'GP registered a login';

async function insertReferrer(over: { mergedInto?: string; userId?: string } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, merged_into, user_id, pseudo)
     VALUES ($1, 'active', 'test', 'test', 'Dr Test', 'dr test', $2, $3, true)`,
    [id, over.mergedInto ?? null, over.userId ?? null],
  );
  return id;
}
const attach = (id: string, body: unknown, who = admin) =>
  app.request(`/admin/referrers/${id}/attach-user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('POST /admin/referrers/:id/attach-user', () => {
  it('links the GP login and clears pseudo; a second referrer cannot take the same login', async () => {
    const id = await insertReferrer();
    const res = await attach(id, { userId: gpUser, reason });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, userId: gpUser, pseudo: false, version: 2 });
    const other = await insertReferrer();
    const dup = await attach(other, { userId: gpUser, reason });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'user_attached' });
  });

  it('409 already_attached when the referrer has a login', async () => {
    const id = await insertReferrer({ userId: seedId('a0000000', 3) });
    const res = await attach(id, { userId: gpUser, reason });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_attached' });
  });

  it('409 merged', async () => {
    const res = await attach(await insertReferrer({ mergedInto: randomUUID() }), { userId: gpUser, reason });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'merged' });
  });

  it('404 for an unknown referrer; 403 without the permission', async () => {
    expect((await attach(randomUUID(), { userId: gpUser, reason })).status).toBe(404);
    expect((await attach('not-a-uuid', { userId: gpUser, reason })).status).toBe(404);
    expect((await attach(await insertReferrer(), { userId: gpUser, reason }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });

  it('422 when the user is not a GP login or does not exist', async () => {
    const id = await insertReferrer();
    for (const userId of [seedId('a0000000', 3), randomUUID()]) {
      const res = await attach(id, { userId, reason });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('422 for a bad body', async () => {
    const id = await insertReferrer();
    expect((await attach(id, { userId: 'nope', reason })).status).toBe(422);
    expect((await attach(id, { userId: gpUser, reason: 'abc' })).status).toBe(422);
    expect((await attach(id, { userId: gpUser, reason, extra: 1 })).status).toBe(422);
  });
});
