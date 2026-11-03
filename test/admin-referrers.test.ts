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

describe('POST /admin/referrers/:id/merge', () => {
  const merge = (id: string, body: unknown, who = admin) =>
    app.request(`/admin/referrers/${id}/merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const addReferral = async (referrerId: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO referrals (id, status, created_by, updated_by, patient_id, referrer_id, referral_date) VALUES ($1, 'received', 'test', 'test', $2, $3, '2026-01-05')`,
      [id, seedId('9a710000', 1), referrerId],
    );
    return id;
  };
  const referrerOf = async (referralId: string) => String((await db.query('SELECT referrer_id FROM referrals WHERE id = $1', [referralId])).rows[0]?.referrer_id);

  it('moves referrals and patients to the kept referrer and marks the duplicate merged', async () => {
    const dup = await insertReferrer();
    const keep = await insertReferrer();
    const referral = await addReferral(dup);
    const res = await merge(dup, { intoReferrerId: keep, reason });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: dup, mergedInto: keep });
    expect(await referrerOf(referral)).toBe(keep);
    const audit = (await db.query(`SELECT changes FROM audit_events WHERE record_id = $1 AND changes IS NOT NULL ORDER BY seq DESC LIMIT 1`, [dup])).rows[0];
    expect(JSON.parse(String(audit?.changes))).toMatchObject({ mergedInto: [null, keep], movedReferralIds: [null, [referral]], movedPatientIds: [null, []] });
  });

  it('moves the duplicate login to the kept referrer when it has none', async () => {
    const dup = await insertReferrer({ userId: gpUser });
    const keep = await insertReferrer();
    const res = await merge(dup, { intoReferrerId: keep, reason });
    expect(res.status).toBe(200);
    expect((await res.json()) as { userId?: string }).not.toHaveProperty('userId');
    const row = (await db.query('SELECT user_id, pseudo FROM referrers WHERE id = $1 ORDER BY version DESC LIMIT 1', [keep])).rows[0];
    expect(row).toMatchObject({ user_id: gpUser, pseudo: false });
  });

  it('409 both_attached and merged; 422 self', async () => {
    const a = await insertReferrer({ userId: seedId('a0000000', 3) });
    const b = await insertReferrer({ userId: seedId('a0000000', 4) });
    const both = await merge(a, { intoReferrerId: b, reason });
    expect(both.status).toBe(409);
    expect(await both.json()).toMatchObject({ error: 'both_attached' });
    const gone = await insertReferrer({ mergedInto: b });
    const c = await insertReferrer();
    expect(await (await merge(gone, { intoReferrerId: c, reason })).json()).toMatchObject({ error: 'merged' });
    const intoGone = await merge(c, { intoReferrerId: gone, reason });
    expect(intoGone.status).toBe(409);
    expect((await merge(c, { intoReferrerId: c, reason })).status).toBe(422);
  });

  it('404 for a missing duplicate, a non-UUID id or a missing target; 403; 422 bad body', async () => {
    const a = await insertReferrer();
    expect((await merge(randomUUID(), { intoReferrerId: a, reason })).status).toBe(404);
    expect((await merge('not-a-uuid', { intoReferrerId: a, reason })).status).toBe(404);
    const target = await merge(a, { intoReferrerId: randomUUID(), reason });
    expect(target.status).toBe(404);
    expect(await target.json()).toMatchObject({ message: 'target referrer not found' });
    expect((await merge(a, { intoReferrerId: randomUUID(), reason }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await merge(a, { intoReferrerId: 'x', reason })).status).toBe(422);
    expect((await merge(a, { intoReferrerId: randomUUID(), reason: 'abc' })).status).toBe(422);
  });
});

describe('POST /admin/referrers/:id/detach', () => {
  const detach = (id: string, body: unknown, who = admin) =>
    app.request(`/admin/referrers/${id}/detach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('unlinks the login and makes the referrer pseudo; another GP can then be attached', async () => {
    const id = await insertReferrer({ userId: gpUser });
    await db.query('UPDATE referrers SET pseudo = false WHERE id = $1', [id]);
    const res = await detach(id, { reason });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id, pseudo: true });
    expect(body).not.toHaveProperty('userId');
    const audit = (await db.query(`SELECT changes FROM audit_events WHERE record_id = $1 AND changes IS NOT NULL ORDER BY seq DESC LIMIT 1`, [id])).rows[0];
    expect(JSON.parse(String(audit?.changes))).toEqual({ userId: [gpUser, null] });
    const other = randomUUID();
    await db.query(
      `INSERT INTO users (id, status, created_by, updated_by, cognito_sub, name, email, mobile, type, department_ids, active)
       VALUES ($1, 'active', 'test', 'test', $2, 'Dr Other GP', 'othergp@dev.local', '9800000099', 'gp', '[]', true)`,
      [other, `sub-${other}`],
    );
    const again = await attach(id, { userId: other, reason });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ userId: other, pseudo: false });
  });

  it('409 not_attached and merged', async () => {
    const res = await detach(await insertReferrer(), { reason });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_attached' });
    const merged = await detach(await insertReferrer({ mergedInto: randomUUID(), userId: gpUser }), { reason });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ error: 'merged' });
  });

  it('404 for unknown and non-UUID ids; 403; 422 bad body', async () => {
    expect((await detach(randomUUID(), { reason })).status).toBe(404);
    expect((await detach('not-a-uuid', { reason })).status).toBe(404);
    const id = await insertReferrer({ userId: gpUser });
    expect((await detach(id, { reason }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await detach(id, { reason: 'abc' })).status).toBe(422);
    expect((await detach(id, { reason, extra: 1 })).status).toBe(422);
  });
});
