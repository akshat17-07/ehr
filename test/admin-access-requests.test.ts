import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const nurseId = seedId('a0000000', 5);
const headId = seedId('a0000000', 2);
const patient = seedId('9a710000', 1);
const { rows: p } = await db.query('SELECT uhid FROM patients WHERE id = $1', [patient]);
const uhid = String(p[0]?.uhid);
const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

async function add(status: string, validUntil: Date | null, at: Date) {
  const decided = status !== 'pending';
  const { rows } = await db.query(
    `INSERT INTO access_requests
       (id, status, created_by, updated_by, created_at, patient_id, requested_by, reason, approver_id, decided_at, valid_until)
     VALUES (gen_random_uuid(), $1, 'dev-nurse', 'dev-nurse', $2, $3, 'dev-nurse', 'follow-up visit', $4, $5, $6) RETURNING id`,
    [status, at, patient, decided ? 'dev-head-doctor' : null, decided ? at : null, validUntil],
  );
  return String(rows[0]!.id);
}

const older = await add('pending', null, hours(-5));
const newer = await add('pending', null, hours(-4));
const approved = await add('approved', hours(2), hours(-3));
const expired = await add('approved', hours(-1), hours(-2));
const rejected = await add('rejected', null, hours(-1));

type Page = { items: { id: string; status: string; requestedBy: string; approverId?: string; uhid?: string; requestedByName?: string }[]; nextCursor?: string };
const list = async (query = '', who = admin) => {
  const res = await app.request(`/admin/access-requests${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};

describe('GET /admin/access-requests', () => {
  it('pending by default, oldest first, with users.id, the UHID and the name', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((r) => r.id)).toEqual([older, newer]);
    expect(body.items[0]).toMatchObject({ status: 'pending', requestedBy: nurseId, requestedByName: 'Sunita Yadav', uhid });
  });

  it('other statuses newest first; expired worked out from validUntil', async () => {
    expect((await list('?status=approved')).body.items.map((r) => r.id)).toEqual([approved]);
    expect((await list('?status=approved')).body.items[0]).toMatchObject({ approverId: headId });
    expect((await list('?status=expired')).body.items.map((r) => [r.id, r.status])).toEqual([[expired, 'expired']]);
    expect((await list('?status=rejected', head)).body.items.map((r) => r.id)).toEqual([rejected]);
  });

  it('pages; 422 for a bad status; 403 without approval.access', async () => {
    const first = await list('?limit=1');
    expect(first.body.items.map((r) => r.id)).toEqual([older]);
    expect((await list(`?limit=1&cursor=${first.body.nextCursor}`)).body.items.map((r) => r.id)).toEqual([newer]);
    expect((await list('?status=gone')).status).toBe(422);
    expect((await list('', asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /admin/access-requests/{id}/approve and /reject', () => {
  const decide = async (id: string, verb: 'approve' | 'reject', body: unknown = {}, who = head) => {
    const res = await app.request(`/admin/access-requests/${id}/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
  const row = async (id: string) => (await db.query('SELECT status, valid_until, version FROM access_requests WHERE id = $1', [id])).rows[0]!;

  it('approves for the hours given, default 24; the approved row is the access', async () => {
    const id = await add('pending', null, hours(-9));
    const { status, body } = await decide(id, 'approve', { hours: 3, note: 'ok' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'approved', approverId: headId, decisionReason: 'ok', requestedBy: nurseId });
    const until = new Date(body.validUntil!).getTime() - Date.now();
    expect(until).toBeGreaterThan(2.9 * 3600_000);
    expect(until).toBeLessThanOrEqual(3 * 3600_000);
    expect((await row(id)).version).toBe(2);

    const other = await add('pending', null, hours(-8));
    const def = await decide(other, 'approve', {}, admin);
    expect(new Date(def.body.validUntil!).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
  });

  it('rejects with the reason kept and no access', async () => {
    const id = await add('pending', null, hours(-7));
    const { status, body } = await decide(id, 'reject', { reason: 'no need to open it' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'rejected', decisionReason: 'no need to open it', approverId: headId });
    expect((await row(id)).valid_until).toBeNull();
  });

  it('409 when not pending, 404 unknown, 422 bad body, 403 without approval.access', async () => {
    const id = await add('pending', null, hours(-6));
    await decide(id, 'reject', { reason: 'not needed' });
    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await decide(id, 'reject', { reason: 'again again' })).status).toBe(409);
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'reject', { reason: 'not needed' })).status).toBe(404);
    const fresh = await add('pending', null, hours(-5.5));
    expect((await decide(fresh, 'reject', { reason: 'no' })).status).toBe(422);
    expect((await decide(fresh, 'approve', { hours: 0 })).status).toBe(422);
    expect((await decide(fresh, 'approve', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await row(fresh)).status).toBe('pending');
  });

  it("can't decide your own request", async () => {
    const { rows } = await db.query(
      `INSERT INTO access_requests (id, status, created_by, updated_by, created_at, patient_id, requested_by, reason)
       VALUES (gen_random_uuid(), 'pending', 'dev-head-doctor', 'dev-head-doctor', $1, $2, 'dev-head-doctor', 'my own patient') RETURNING id`,
      [hours(-1), patient],
    );
    const id = String(rows[0]!.id);
    expect((await decide(id, 'approve')).status).toBe(403);
    expect((await decide(id, 'reject', { reason: 'nope nope' })).status).toBe(403);
    expect((await decide(id, 'approve', {}, admin)).status).toBe(200);
  });
});
