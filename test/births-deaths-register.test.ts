import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
// Everyone counts as recently active, so the inactive-patient rule does not apply.
await db.query('UPDATE patients SET last_activity_at = now()');
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const kavita = seedId('9a710000', 4);
const ramesh = seedId('9a710000', 1);
const drId = seedId('a0000000', 3);

async function birth(bornAt: string, o: { voided?: boolean; reportedAt?: string; ref?: string; order?: number } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO births (id, status, created_by, updated_by, voided_at, mother_patient_id, born_at, sex, weight_grams, outcome, delivery, birth_order, delivered_by, reported_at, registrar_ref)
     VALUES ($1, 'active', 'x', 'x', $2, $3, $4, 'F', 2800, 'live', 'normal', $5, $6, $7, $8)`,
    [id, o.voided ? new Date(bornAt) : null, kavita, bornAt, o.order ?? 1, drId, o.reportedAt ?? null, o.ref ?? null],
  );
  return id;
}
async function death(diedAt: string, patientId = ramesh, voided = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO deaths (id, status, created_by, updated_by, voided_at, patient_id, died_at, immediate_cause, antecedent_causes, icd10, manner, mlc, certified_by)
     VALUES ($1, 'active', 'x', 'x', $2, $3, $4, 'Cardiac arrest', '["MI"]', '["I21.9"]', 'natural', false, $5)`,
    [id, voided ? new Date(diedAt) : null, patientId, diedAt, drId],
  );
  return id;
}
const get = (qs: string, who = admin) => app.request(`/admin/registers/births-deaths?${qs}`, {}, who);
type Row = { kind: string; id: string; date: string; at: string; patientId: string; uhid: string; patientName: string; dueBy: string; reported: boolean; registrarRef?: string; details: Record<string, unknown> };

describe('GET /admin/registers/births-deaths (#330)', () => {
  it('lists births and deaths by time with names, dueBy, reported and details; voided are left out', async () => {
    const b = await birth('2026-05-10T04:00:00Z', { reportedAt: '2026-05-12T04:00:00Z', ref: 'MP/26/9' });
    const d = await death('2026-05-09T04:00:00Z');
    await birth('2026-05-11T04:00:00Z', { voided: true });
    await death('2026-05-11T04:00:00Z', kavita, true);
    const res = await get('from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Row[];
    expect(rows.map((r) => [r.kind, r.id])).toEqual([['death', d], ['birth', b]]);
    expect(rows[0]).toMatchObject({
      date: '2026-05-09', patientId: ramesh, uhid: 'U24000001', patientName: 'Ramesh Kumar Sharma', dueBy: '2026-05-30', reported: false,
      details: { immediateCause: 'Cardiac arrest', antecedentCauses: ['MI'], icd10: ['I21.9'], manner: 'natural', mlc: false, certifiedBy: { id: drId, name: 'Dr Neha Gupta' } },
    });
    expect(rows[0]).not.toHaveProperty('registrarRef');
    expect(rows[1]).toMatchObject({
      date: '2026-05-10', patientId: kavita, patientName: 'Kavita Patel', dueBy: '2026-05-31', reported: true, registrarRef: 'MP/26/9',
      details: { sex: 'F', weightGrams: 2800, outcome: 'live', delivery: 'normal', birthOrder: 1, deliveredBy: { id: drId, name: 'Dr Neha Gupta' } },
    });
  });

  it('kind filter, and the India-date edge just after midnight IST', async () => {
    // 31 Jul 18:31 UTC = 1 Aug 00:01 IST; 31 Jul 18:29 UTC = 31 Jul 23:59 IST.
    const justAfter = await birth('2026-07-31T18:31:00Z');
    const justBefore = await death('2026-07-31T18:29:00Z');
    const aug = (await (await get('from=2026-08-01&to=2026-08-01')).json()) as Row[];
    expect(aug.map((r) => r.id)).toEqual([justAfter]);
    expect(aug[0]).toMatchObject({ date: '2026-08-01', dueBy: '2026-08-22' });
    const jul = (await (await get('from=2026-07-31&to=2026-07-31')).json()) as Row[];
    expect(jul.map((r) => r.id)).toEqual([justBefore]);
    expect(jul[0]).toMatchObject({ date: '2026-07-31' });
    const both = (await (await get('from=2026-07-31&to=2026-08-01')).json()) as Row[];
    expect(both.map((r) => r.id)).toEqual([justBefore, justAfter]);
    expect(((await (await get('from=2026-07-31&to=2026-08-01&kind=birth')).json()) as Row[]).map((r) => r.kind)).toEqual(['birth']);
    expect(((await (await get('from=2026-07-31&to=2026-08-01&kind=death')).json()) as Row[]).map((r) => r.kind)).toEqual(['death']);
  });

  it('the dueBy date crosses a month end; an empty period is []', async () => {
    await birth('2026-09-20T10:00:00Z');
    const rows = (await (await get('from=2026-09-20&to=2026-09-20')).json()) as Row[];
    expect(rows[0]).toMatchObject({ date: '2026-09-20', dueBy: '2026-10-11' });
    expect(await (await get('from=2020-01-01&to=2020-01-02')).json()).toEqual([]);
  });

  it('422 for a bad period, over 366 days, bad kind or unknown parameter; 366 days is allowed', async () => {
    expect((await get('from=2026-05-10&to=2026-05-09')).status).toBe(422);
    expect((await get('from=2026-05-01')).status).toBe(422);
    expect((await get('from=2025-01-01&to=2026-01-02')).status).toBe(422);
    expect((await get('from=2025-01-01&to=2026-01-01')).status).toBe(200);
    expect((await get('from=2026-05-01&to=2026-05-02&kind=other')).status).toBe(422);
    expect((await get('from=2026-05-01&to=2026-05-02&x=1')).status).toBe(422);
  });

  it('needs compliance.registers: 403 for a doctor, 401 with no login; the read is audited', async () => {
    expect((await get('from=2026-05-01&to=2026-05-02', doctor)).status).toBe(403);
    expect((await app.request('/admin/registers/births-deaths?from=2026-05-01&to=2026-05-02')).status).toBe(401);
    await get('from=2026-05-01&to=2026-05-02');
    const { rows } = await db.query("SELECT * FROM audit_events WHERE record_type = 'register' AND record_id = 'births-deaths 2026-05-01..2026-05-02'");
    expect(rows).toHaveLength(1);
  });
});
