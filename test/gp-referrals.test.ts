import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #403-#404: /other/gp/referrals* scoped to the GP's own (and merged-duplicate) referrers; one generic 403.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const gp = asStaff('dev-gp', ['gp']);
const doctor = asStaff('dev-doctor', ['doctor']);

const gpUserId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-gp'")).rows[0]?.id);
const [ramesh, sita, irfan] = [1, 2, 3].map((n) => seedId('9a710000', n)) as [string, string, string];

async function referrer(userId: string | null, mergedInto: string | null = null) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, merged_into, user_id, pseudo)
     VALUES ($1, 'active', 'test', 'test', 'Dr Test', 'dr test', $2, $3, false)`,
    [id, mergedInto, userId],
  );
  return id;
}

async function referral(referrerId: string, patientId: string, date: string, status = 'received', reason: string | null = null, voided = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrals (id, status, created_at, updated_at, created_by, updated_by, patient_id, referrer_id, referral_date, reason, voided_at, voided_by, void_reason)
     VALUES ($1, $2, '2026-03-01T00:00:00Z', '2026-03-02T10:00:00Z', 'staff-secret', 'staff-secret', $3, $4, $5, $6, $7, $8, $9)`,
    [id, voided ? 'void' : status, patientId, referrerId, date, reason, voided ? '2026-03-03T00:00:00Z' : null, voided ? 'test' : null, voided ? 'Wrong' : null],
  );
  return id;
}

const own = await referrer(gpUserId);
const dup = await referrer(null, own);
const other = await referrer(null);

const rOwn = await referral(own, ramesh, '2026-02-10', 'seen', 'Knee pain');
const rDup = await referral(dup, sita, '2026-02-20');
const rOld = await referral(own, irfan, '2026-01-05', 'admitted');
const rVoid = await referral(own, ramesh, '2026-02-25', 'received', null, true);
const rOther = await referral(other, ramesh, '2026-02-15');

const get = (path: string, who = gp) => app.request(`/other/gp/referrals${path}`, {}, who);
type Item = { referralId: string; patientName: string; date: string; status: string };

describe('GET /other/gp/referrals', () => {
  it('lists own and merged-duplicate referrals, newest first, with only the allowed fields', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[] };
    expect(body.items.map((i) => i.referralId)).toEqual([rDup, rOwn, rOld]);
    expect(Object.keys(body.items[0]!).sort()).toEqual(['date', 'patientName', 'referralId', 'status']);
    expect(body.items[0]).toMatchObject({ date: '2026-02-20', status: 'received' });
    expect(body.items[0]!.patientName).toBeTruthy();
  });

  it('filters by status; a bad status is 422', async () => {
    const body = (await (await get('?status=seen')).json()) as { items: Item[] };
    expect(body.items.map((i) => i.referralId)).toEqual([rOwn]);
    expect((await get('?status=nope')).status).toBe(422);
  });

  it('pages with limit=1', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const body = (await (await get(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json()) as { items: Item[]; nextCursor?: string };
      seen.push(...body.items.map((x) => x.referralId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([rDup, rOwn, rOld]);
  });

  it('is empty for a GP with no referrer, and 403 for a non-GP', async () => {
    const res = await get('', asStaff('dev-gp-nobody', ['gp']));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect((await get('', doctor)).status).toBe(403);
  });
});

describe('GET /other/gp/referrals/:id', () => {
  it('returns exactly the allowed fields', async () => {
    const res = await get(`/${rOwn}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['date', 'lastUpdate', 'patientName', 'reason', 'referralId', 'status']);
    expect(body).toMatchObject({ referralId: rOwn, date: '2026-02-10', reason: 'Knee pain', status: 'seen', lastUpdate: '2026-03-02T10:00:00.000Z' });
  });

  it('omits reason when empty and works for a merged duplicate', async () => {
    const body = (await (await get(`/${rDup}`)).json()) as Record<string, unknown>;
    expect(body.reason).toBeUndefined();
    expect(body.referralId).toBe(rDup);
  });

  it('gives the same 403 for unrelated, voided, unknown and malformed ids', async () => {
    const bodies: string[] = [];
    for (const id of [rOther, rVoid, randomUUID(), 'not-a-uuid']) {
      const res = await get(`/${id}`);
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ error: 'forbidden' });
  });
});
