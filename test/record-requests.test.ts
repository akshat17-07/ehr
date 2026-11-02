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
const ramesh = seedId('9a710000', 1);

/** A request row straight in the table, made `hoursAgo` ago (POST comes at #146). */
async function insertRequest(hoursAgo: number, status = 'pending') {
  const id = randomUUID();
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  await db.query(
    `INSERT INTO record_requests (id, status, created_at, updated_at, created_by, updated_by, patient_id, requested_by, scope, include_sensitive, email)
     VALUES ($1, $2, $3, $3, 'test', 'test', $4, 'patient', 'full', false, 'ramesh@example.in')`,
    [id, status, at, ramesh],
  );
  return id;
}

describe('GET /staff/record-requests', () => {
  it('lists oldest first with a 72-hour due time, filtered by status and overdue', async () => {
    const late = await insertRequest(80);
    const fresh = await insertRequest(2);
    const done = await insertRequest(90, 'fulfilled');
    const list = async (q = '') => ((await (await app.request(`/staff/record-requests${q}`, {}, admin)).json()) as { items: { id: string; dueBy: string }[] }).items;
    const all = await list();
    expect(all.map((r) => r.id)).toEqual([done, late, fresh]);
    expect(all[2]).toMatchObject({ status: 'pending', patientId: ramesh, requestedBy: 'patient', scope: 'full', includeSensitive: false, email: 'ramesh@example.in' });
    const due = new Date(all[2]!.dueBy).getTime() - Date.now();
    expect(due).toBeGreaterThan(69 * 3_600_000);
    expect(due).toBeLessThan(71 * 3_600_000);
    expect((await list('?overdue=true')).map((r) => r.id)).toEqual([late]);
    expect((await list('?overdue=false')).map((r) => r.id)).toEqual([done, fresh]);
    expect((await list('?status=fulfilled')).map((r) => r.id)).toEqual([done]);
  });

  it('403 without records.release (a doctor); 422 for a bad status', async () => {
    expect((await app.request('/staff/record-requests', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await app.request('/staff/record-requests?status=lost', {}, admin)).status).toBe(422);
  });
});

describe('POST /staff/record-requests', () => {
  const post = (body: unknown, who = admin) => app.request('/staff/record-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const irfan = seedId('9a710000', 3);
  const openVisit = async (patientId: string) => {
    const body = { patientId, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) };
    const res = await app.request('/staff/encounters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, asStaff('dev-doctor', ['doctor']));
    return ((await res.json()) as { id: string }).id;
  };

  it('takes a request at the counter, due in 72 hours', async () => {
    const res = await post({ patientId: ramesh, scope: 'full', email: 'ramesh@example.in' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { createdAt: string; dueBy: string };
    expect(made).toMatchObject({ status: 'pending', patientId: ramesh, requestedBy: 'counter', scope: 'full', includeSensitive: false, createdBy: 'dev-admin' });
    expect(new Date(made.dueBy).getTime() - new Date(made.createdAt).getTime()).toBe(72 * 3_600_000);
  });

  it('scope encounter needs the patient own encounters', async () => {
    const visit = await openVisit(irfan);
    const ok = await post({ patientId: irfan, scope: 'encounter', encounterIds: [visit], includeSensitive: true, email: 'irfan@example.in' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ scope: 'encounter', encounterIds: [visit], includeSensitive: true });
    expect((await post({ patientId: ramesh, scope: 'encounter', encounterIds: [visit], email: 'r@example.in' })).status).toBe(422);
    expect((await post({ patientId: irfan, scope: 'encounter', email: 'r@example.in' })).status).toBe(422);
    expect((await post({ patientId: irfan, scope: 'full', encounterIds: [visit], email: 'r@example.in' })).status).toBe(422);
  });

  it('422 for a bad email; 404 for no patient; 403 for a doctor', async () => {
    expect((await post({ patientId: ramesh, scope: 'full', email: 'not-an-email' })).status).toBe(422);
    expect((await post({ patientId: seedId('9a710000', 999), scope: 'full', email: 'x@example.in' })).status).toBe(404);
    expect((await post({ patientId: ramesh, scope: 'full', email: 'x@example.in' }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
