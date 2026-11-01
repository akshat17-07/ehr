import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import type { AccessRequest } from '../src/modules/access/access-requests.js';

const db = await openLocalDb();
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
