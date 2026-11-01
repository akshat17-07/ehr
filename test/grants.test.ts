import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { activeGrants, createGrant, revokeGrant, type NewGrant } from '../src/permissions/grants.js';

const now = new Date('2026-11-01T10:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
const base: NewGrant = { userId: 'u-doc', permission: 'pcpndt.write', scope: 'all', end: days(30), grantorId: 'u-head', reason: 'USG duty' };

describe('grants', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  it('gives a permission from now until the end', async () => {
    const grant = await createGrant(db, base, now);
    expect(grant).toMatchObject({
      userId: 'u-doc', permission: 'pcpndt.write', scope: 'all', grantorId: 'u-head', status: 'active', version: 1,
      start: now.toISOString(), end: days(30).toISOString(),
    });
    expect(grant).not.toHaveProperty('scopeId');
  });

  it('counts only grants that have started, not ended and not been revoked', async () => {
    const user = 'u-count';
    const kept = await createGrant(db, { ...base, userId: user, permission: 'mtp.view' }, now);
    await createGrant(db, { ...base, userId: user, permission: 'mtp.write', start: days(2), end: days(5) }, now); // not started
    const ending = await createGrant(db, { ...base, userId: user, permission: 'sensitive.view', end: days(1) }, now);
    const revoked = await createGrant(db, { ...base, userId: user, permission: 'pcpndt.view' }, now);
    await revokeGrant(db, { id: revoked.id, version: 1, by: 'u-head', reason: 'left the unit' }, now);

    expect((await activeGrants(db, user, now)).map((g) => g.permission).sort()).toEqual(['mtp.view', 'sensitive.view']);
    const later = await activeGrants(db, user, days(3));
    expect(later.map((g) => g.permission).sort()).toEqual(['mtp.view', 'mtp.write']);
    expect(later.find((g) => g.id === ending.id)).toBeUndefined();
    expect(kept.status).toBe('active');
  });

  it('revoking keeps the row, once', async () => {
    const grant = await createGrant(db, { ...base, userId: 'u-rev' }, now);
    expect(await revokeGrant(db, { id: grant.id, version: 1, by: 'u-head', reason: 'done' }, now)).toMatchObject({ status: 'revoked', version: 2 });
    await expect(revokeGrant(db, { id: grant.id, version: 2, by: 'u-head', reason: 'again' }, now)).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT count(*)::int AS n FROM grants_versions WHERE record_id = $1', [grant.id])).rows[0]).toEqual({ n: 1 });
  });

  it('a stale version or unknown grant cannot be revoked', async () => {
    const grant = await createGrant(db, { ...base, userId: 'u-stale' }, now);
    await expect(revokeGrant(db, { id: grant.id, version: 5, by: 'u-head', reason: 'x' }, now)).rejects.toMatchObject({ status: 409 });
    await expect(revokeGrant(db, { id: '00000000-0000-4000-8000-000000000999', version: 1, by: 'u', reason: 'x' }, now)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps department and patient scope', async () => {
    const grant = await createGrant(db, { ...base, scope: 'patient', scopeId: 'p-1' }, now);
    expect(grant).toMatchObject({ scope: 'patient', scopeId: 'p-1' });
  });

  it('refuses grants that break the rules', async () => {
    const bad: [Partial<NewGrant>, string][] = [
      [{ permission: 'patient.delete' }, 'unknown permission'],
      [{ permission: 'user.permissions' }, "can't be granted"],
      [{ permission: 'role.promote_head_doctor' }, "can't be granted"],
      [{ userId: 'u-head' }, 'themselves'],
      [{ scope: 'patient' }, 'scopeId'],
      [{ scopeId: 'd-1' }, 'scopeId'],
      [{ start: days(3), end: days(2) }, 'after start'],
      [{ start: days(-10), end: days(-1) }, 'in the future'],
      [{ end: days(366) }, '365 days'],
      [{ reason: ' ' }, 'reason'],
    ];
    for (const [change, message] of bad) {
      await expect(createGrant(db, { ...base, ...change }, now), message).rejects.toMatchObject({ status: 422, message: expect.stringContaining(message) });
    }
  });
});
