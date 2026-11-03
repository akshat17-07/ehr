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
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);
const nurseId = seedId('a0000000', 5);
const headId = seedId('a0000000', 2);
const patient = seedId('9a710000', 1);
const { rows: p } = await db.query('SELECT uhid FROM patients WHERE id = $1', [patient]);
const uhid = String(p[0]?.uhid);
const day = (d: string) => new Date(`${d}T10:00:00+05:30`);

async function add(sub: string, at: Date, reviewed = false) {
  const { rows } = await db.query(
    `INSERT INTO break_glass_events (id, status, created_by, updated_by, created_at, patient_id, user_id, reason, at, valid_until, reviewed_by, review_outcome, review_note)
     VALUES (gen_random_uuid(), 'active', $1, $1, $2, $3, $1, 'cardiac arrest, no time to ask', $2, $4, $5, $6, $7) RETURNING id`,
    [sub, at, patient, new Date(at.getTime() + 3_600_000), reviewed ? 'dev-admin' : null, reviewed ? 'justified' : null, reviewed ? 'genuine emergency' : null],
  );
  return String(rows[0]!.id);
}
const first = await add('dev-nurse', day('2026-03-01'));
const second = await add('dev-doctor', day('2026-03-05'));
const done = await add('dev-nurse', day('2026-03-03'), true);

type Event = { id: string; userId: string; userName?: string; uhid?: string; reviewedBy?: string; reviewOutcome?: string; reviewNote?: string };
type Page = { items: Event[]; nextCursor?: string };
const list = async (query = '', who = head) => {
  const res = await app.request(`/admin/break-glass-events${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};
const review = async (id: string, body: unknown, who = head) => {
  const res = await app.request(`/admin/break-glass-events/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  return { status: res.status, body: (await res.json()) as Event };
};

describe('GET /admin/break-glass-events', () => {
  it('newest first, with users.id, the UHID and the name; reviewed ones show who and the outcome', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((e) => e.id)).toEqual([second, done, first]);
    expect(body.items[2]).toMatchObject({ userId: nurseId, userName: 'Sunita Yadav', uhid });
    expect(body.items[1]).toMatchObject({ reviewedBy: seedId('a0000000', 1), reviewOutcome: 'justified', reviewNote: 'genuine emergency' });
  });

  it('reviewed=false lists the waiting ones oldest first; reviewed=true the others; from / to are India days', async () => {
    expect((await list('?reviewed=false')).body.items.map((e) => e.id)).toEqual([first, second]);
    expect((await list('?reviewed=true')).body.items.map((e) => e.id)).toEqual([done]);
    expect((await list('?from=2026-03-02&to=2026-03-03')).body.items.map((e) => e.id)).toEqual([done]);
    expect((await list('?from=2026-03-05')).body.items.map((e) => e.id)).toEqual([second]);
  });

  it('pages; 422 for a bad filter; 403 without audit.read', async () => {
    const one = await list('?limit=1');
    expect(one.body.items.map((e) => e.id)).toEqual([second]);
    expect((await list(`?limit=1&cursor=${one.body.nextCursor}`)).body.items.map((e) => e.id)).toEqual([done]);
    expect((await list('?reviewed=maybe')).status).toBe(422);
    expect((await list('', doctor)).status).toBe(403);
  });
});

describe('POST /admin/break-glass-events/{id}/review', () => {
  it('records the reviewer, outcome and note', async () => {
    const { status, body } = await review(first, { outcome: 'not_justified', note: 'a routine visit, not an emergency' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: first, reviewedBy: headId, reviewOutcome: 'not_justified', reviewNote: 'a routine visit, not an emergency', userId: nurseId });
    expect((await list('?reviewed=false')).body.items.map((e) => e.id)).toEqual([second]);
  });

  it('409 if already reviewed; 404; 422 for a bad body; 403 without audit.review', async () => {
    expect((await review(done, { outcome: 'justified', note: 'looked again' })).status).toBe(409);
    expect((await review(randomUUID(), { outcome: 'justified', note: 'fine' })).status).toBe(404);
    expect((await review('nope', { outcome: 'justified', note: 'fine' })).status).toBe(404);
    expect((await review(second, { outcome: 'maybe', note: 'fine' })).status).toBe(422);
    expect((await review(second, { outcome: 'justified' })).status).toBe(422);
    expect((await review(second, { outcome: 'justified', note: 'fine' }, doctor)).status).toBe(403);
  });

  it("can't review your own emergency access", async () => {
    const own = await add('dev-head-doctor', day('2026-03-06'));
    expect((await review(own, { outcome: 'justified', note: 'my own' })).status).toBe(403);
    expect((await review(own, { outcome: 'justified', note: 'checked by admin' }, admin)).status).toBe(200);
  });
});
