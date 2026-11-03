import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { appendAudit } from '../src/audit/log.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const patient = seedId('9a710000', 1);
const doctorId = seedId('a0000000', 3);

const log = (userId: string, role: string, action: 'view' | 'update', patientId: string, recordType: string) =>
  appendAudit(db, { userId, role, action, patientId, recordType, recordId: randomUUID(), ip: '10.0.0.1', device: 'test' });
await log('dev-doctor', 'doctor', 'view', patient, 'note');
await log('dev-nurse', 'nurse', 'update', patient, 'vitals');
await log('ghost-sub', 'staff', 'view', seedId('9a710000', 2), 'note');

type Event = { seq: number; id: string; userId: string; userName?: string; action: string; patientId?: string; recordType?: string; reason?: string; hash: string };
type Page = { items: Event[]; nextCursor?: string };
const get = async (query = '', who = admin) => {
  const res = await app.request(`/admin/audit${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};
const verify = async (who = admin) => {
  const res = await app.request('/admin/audit/verify', {}, who);
  return { status: res.status, body: (await res.json()) as { checkedAt: string; ok: boolean; rows: number; firstBrokenId?: string } };
};

describe('GET /admin/audit', () => {
  it('lists newest first with users.id and the name', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.items.map((e) => e.seq)).toEqual([...body.items.map((e) => e.seq)].sort((a, b) => b - a));
    expect(body.items.slice(0, 3).map((e) => [e.userId, e.action])).toEqual([['ghost-sub', 'view'], [seedId('a0000000', 5), 'update'], [doctorId, 'view']]);
    expect(body.items[2]!.userName).toBeTypeOf('string');
    expect(body.items[0]).not.toHaveProperty('userName');
    expect(body.items[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters by user, patient, action, record type and day', async () => {
    expect((await get(`?userId=${doctorId}`)).body.items.every((e) => e.userId === doctorId)).toBe(true);
    expect((await get('?userId=ghost-sub')).body.items.map((e) => e.userId)).toEqual(['ghost-sub']);
    const byPatient = (await get(`?patientId=${patient}`)).body.items;
    expect(byPatient.length).toBeGreaterThanOrEqual(2);
    expect(byPatient.every((e) => e.patientId === patient)).toBe(true);
    const updates = (await get('?action=update')).body.items;
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((e) => e.action === 'update')).toBe(true);
    expect((await get('?recordType=vitals')).body.items.map((e) => e.userId)).toEqual([seedId('a0000000', 5)]);
    expect((await get('?from=2020-01-01&to=2020-01-02')).body.items).toEqual([]);
  });

  it('pages without repeating', async () => {
    const first = await get('?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTypeOf('string');
    const second = await get(`?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0]!.seq).toBeLessThan(first.body.items[1]!.seq);
  });

  it('audits the read with the filters, not the rows', async () => {
    await get(`?patientId=${patient}&action=view`);
    const row = (await db.query("SELECT patient_id::text AS patient_id, reason, changes FROM audit_events WHERE record_type = 'audit_log' AND reason IS NOT NULL ORDER BY seq DESC LIMIT 1")).rows[0];
    expect(row?.patient_id).toBe(patient);
    expect(JSON.parse(String(row?.reason).replace('filters: ', ''))).toEqual({ patientId: patient, action: 'view' });
    expect(row?.changes).toBeNull();
  });

  it('403 without audit.read; 422 for a bad query', async () => {
    expect((await get('', doctor)).status).toBe(403);
    for (const q of ['?action=peek', '?patientId=nope', '?from=yesterday', '?limit=0', '?x=1']) expect((await get(q)).status, q).toBe(422);
  });
});

describe('GET /admin/audit/verify', () => {
  it('403 without audit.read', async () => {
    expect((await verify(doctor)).status).toBe(403);
  });

  it('reports ok for an intact chain, then the first broken row after tampering', async () => {
    const ok = await verify();
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.rows).toBeGreaterThan(3);
    expect(ok.body.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(ok.body).not.toHaveProperty('firstBrokenId');

    const target = (await db.query('SELECT id::text AS id FROM audit_events WHERE audit_events.seq = 2')).rows[0];
    await db.query("UPDATE audit_events SET user_id = 'someone-else' WHERE seq = 2");
    const bad = await verify();
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, firstBrokenId: target?.id });
  });
});
