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
