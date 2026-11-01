import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import type { AccessRequest } from '../src/modules/access/access-requests.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });
const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

async function list(query = '', sub = 'nurse-1') {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': '[nurse]' };
  const env = { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
  const res = await app.request(`/staff/me/access-requests${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as { items: AccessRequest[]; nextCursor?: string } };
}

async function add(requestedBy: string, patientId: string, status: string, validUntil: Date | null, at: Date) {
  const decided = status !== 'pending';
  await db.query(
    `INSERT INTO access_requests
       (id, status, created_by, updated_by, created_at, patient_id, requested_by, reason, approver_id, decided_at, valid_until)
     VALUES (gen_random_uuid(), $1, $2, $2, $3, $4, $2, 'follow-up visit', $5, $6, $7)`,
    [status, requestedBy, at, patientId, decided ? 'head-1' : null, decided ? at : null, validUntil],
  );
}

describe('GET /staff/me/access-requests', () => {
  it('lists only the caller requests, newest first, with expired worked out', async () => {
    await add('nurse-1', 'p-1', 'pending', null, hours(-4));
    await add('nurse-1', 'p-2', 'approved', hours(2), hours(-3));
    await add('nurse-1', 'p-3', 'approved', hours(-1), hours(-2));
    await add('nurse-1', 'p-4', 'rejected', null, hours(-1));
    await add('doc-1', 'p-9', 'pending', null, hours(0));

    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((r) => [r.patientId, r.status])).toEqual([
      ['p-4', 'rejected'],
      ['p-3', 'expired'],
      ['p-2', 'approved'],
      ['p-1', 'pending'],
    ]);
    expect(body.items[2]).toMatchObject({ requestedBy: 'nurse-1', reason: 'follow-up visit', approverId: 'head-1', validUntil: expect.any(String) });
    expect(body.items[3]).not.toHaveProperty('approverId');
  });

  it('filters by status, expired and approved included', async () => {
    const cases = [['pending', 'p-1'], ['approved', 'p-2'], ['expired', 'p-3'], ['rejected', 'p-4']];
    for (const [s, patient] of cases) expect((await list(`?status=${s}`)).body.items.map((r) => r.patientId)).toEqual([patient]);
    expect((await list('?status=open')).status).toBe(422);
  });

  it('pages', async () => {
    const first = await list('?limit=3');
    const second = await list(`?limit=3&cursor=${first.body.nextCursor}`);
    expect([...first.body.items, ...second.body.items].map((r) => r.patientId)).toEqual(['p-4', 'p-3', 'p-2', 'p-1']);
  });
});

describe('POST /staff/access-requests', () => {
  const sita = '9a710000-0000-4000-8000-000000000002';
  const ask = (body: unknown, sub = 'dev-nurse', group = 'nurse') => {
    const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${group}]` };
    const env = { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
    return app.request('/staff/access-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
  };

  it('asks for access, pending, logged against the patient', async () => {
    const res = await ask({ patientId: sita, reason: 'follow-up after 40 days' });
    expect(res.status).toBe(201);
    const request = (await res.json()) as AccessRequest;
    expect(request).toMatchObject({ patientId: sita, requestedBy: 'dev-nurse', status: 'pending', reason: 'follow-up after 40 days' });
    const audit = await db.query("SELECT record_type, reason FROM audit_events WHERE patient_id = $1 AND action = 'create'", [sita]);
    expect(audit.rows).toEqual([{ record_type: 'access_request', reason: 'follow-up after 40 days' }]);
  });

  it('409 while one is pending or still approved; a new one after it expires', async () => {
    expect((await ask({ patientId: sita, reason: 'again' })).status).toBe(409);
    await db.query("UPDATE access_requests SET status = 'approved', valid_until = $1 WHERE requested_by = 'dev-nurse'", [hours(1)]);
    expect((await ask({ patientId: sita, reason: 'again' })).status).toBe(409);
    await db.query("UPDATE access_requests SET valid_until = $1 WHERE requested_by = 'dev-nurse'", [hours(-1)]);
    expect((await ask({ patientId: sita, reason: 'again' })).status).toBe(201);
  });

  it('422 for no such patient or no reason; 403 without access.request', async () => {
    expect((await ask({ patientId: '9a710000-0000-4000-8000-000000000999', reason: 'visit' })).status).toBe(422);
    expect((await ask({ patientId: sita })).status).toBe(422);
    expect((await ask({ patientId: sita, reason: 'visit' }, 'dev-gp', 'gp')).status).toBe(403);
  });
});
