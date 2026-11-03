import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { appendAudit } from '../src/audit/log.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);
const patient = seedId('9a710000', 1);
const other = seedId('9a710000', 2);
const doctorId = seedId('a0000000', 3);
const nurseId = seedId('a0000000', 5);

const log = (userId: string, role: string, action: 'view' | 'update', patientId: string, reason?: string) =>
  appendAudit(db, { userId, role, action, patientId, recordType: 'note', recordId: randomUUID(), ...(reason && { reason }), ip: '10.0.0.1', device: 'test' });
await log('dev-doctor', 'doctor', 'view', patient);
await log('dev-nurse', 'nurse', 'update', patient, 'corrected the dose');
await log('ghost-sub', 'staff', 'view', patient);
await log('dev-doctor', 'doctor', 'view', other);

type Event = { seq: number; userId: string; userName?: string; action: string; patientId: string; reason?: string; hash: string; prevHash: string; role: string };
type Page = { items: Event[]; nextCursor?: string };
const get = async (id: string, query = '', who = admin) => {
  const res = await app.request(`/admin/patients/${id}/access-log${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};

describe('GET /admin/patients/{id}/access-log', () => {
  it("lists that patient's audit rows newest first, with users.id and the name", async () => {
    const { status, body } = await get(patient);
    expect(status).toBe(200);
    const mine = body.items; // the read of the log is written after the reply, so it is not in this page
    expect(mine.map((e) => [e.userId, e.action])).toEqual([['ghost-sub', 'view'], [nurseId, 'update'], [doctorId, 'view']]);
    expect(body.items.every((e) => e.patientId === patient)).toBe(true);
    expect(mine[1]).toMatchObject({ userName: 'Sunita Yadav', reason: 'corrected the dose', role: 'nurse' });
    expect(mine[0]).not.toHaveProperty('userName');
    expect(mine[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.items.map((e) => e.seq)).toEqual([...body.items.map((e) => e.seq)].sort((a, b) => b - a));
  });

  it('reading the log is itself logged against the patient', async () => {
    const before = (await get(patient)).body.items.length;
    const after = (await get(patient)).body.items;
    expect(after.length).toBeGreaterThan(before);
    expect(after[0]).toMatchObject({ action: 'view', role: 'admin' });
  });

  it('filters by India day, and pages without repeating', async () => {
    const today = indiaDate();
    const all = (await get(patient, `?from=${today}&to=${today}`)).body.items;
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect((await get(patient, '?from=2020-01-01&to=2020-01-02')).body.items).toEqual([]);
    const first = await get(patient, '?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTypeOf('string');
    const second = await get(patient, `?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0]!.seq).toBeLessThan(first.body.items[1]!.seq);
  });

  it('404 for no such patient; 422 for bad query; 403 without audit.read', async () => {
    expect((await get(randomUUID())).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
    expect((await get(patient, '?from=yesterday')).status).toBe(422);
    expect((await get(patient, '', doctor)).status).toBe(403);
    expect((await get(patient, '', head)).status).toBe(200);
  });
});
