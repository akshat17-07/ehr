import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
const doctor = asStaff('dev-doctor', ['doctor']);
const kavita = seedId('9a710000', 4);
const drId = seedId('a0000000', 3);

async function formF(createdAt: string, o: { voided?: boolean; indication?: string } = {}) {
  const { rows } = await db.query(
    `INSERT INTO form_f (id, status, created_by, updated_by, created_at, updated_at, voided_at, encounter_id, patient_id, doctor_id, indication, procedure, declaration_signed)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $1, $2, $3, $4, $5, $6, 'Ultrasound, obstetric', true) RETURNING id`,
    [createdAt, o.voided ? createdAt : null, randomUUID(), kavita, drId, o.indication ?? 'Dating scan'],
  );
  return String(rows[0]?.id);
}
async function diagnosis(createdAt: string, icd10: string, o: { voided?: boolean } = {}) {
  const { rows } = await db.query(
    `INSERT INTO diagnoses (id, status, created_by, updated_by, created_at, updated_at, voided_at, encounter_id, patient_id, icd10, text, kind)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $1, $2, $3, $4, $5, 'Dx text', 'final') RETURNING id`,
    [createdAt, o.voided ? createdAt : null, randomUUID(), kavita, icd10],
  );
  return String(rows[0]?.id);
}

describe('GET /admin/registers/pcpndt-monthly', () => {
  const get = (q: string, who = admin) => app.request(`/admin/registers/pcpndt-monthly${q}`, {}, who);

  it('lists the month in India time, ordered, without voided or other months; no fetal-sex field', async () => {
    const early = await formF('2031-04-30T18:30:00Z', { indication: 'IST 1 May 00:00' }); // 2031-05-01 00:00 IST
    const late = await formF('2031-05-31T18:29:59Z', { indication: 'IST 31 May 23:59' });
    await formF('2031-04-30T18:29:59Z'); // 30 April IST
    await formF('2031-05-31T18:30:00Z'); // 1 June IST
    await formF('2031-05-10T05:00:00Z', { voided: true });
    const res = await get('?month=2031-05');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; rows: Record<string, unknown>[] };
    expect(body.month).toBe('2031-05');
    expect(body.rows.map((r) => r.formFId)).toEqual([early, late]);
    expect(body.rows[0]).toMatchObject({
      date: '2031-05-01', encounterId: expect.any(String), patientId: kavita, uhid: expect.any(String), patientName: expect.any(String),
      doctorId: drId, indication: 'IST 1 May 00:00', procedure: 'Ultrasound, obstetric', declarationSigned: true, documentId: null,
    });
    expect(body.rows[0]?.doctorName).toBeTruthy();
    expect(body.rows[1]?.date).toBe('2031-05-31');
    expect(JSON.stringify(body)).not.toMatch(/sex|gender|fetal/i);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'register' AND record_id = 'pcpndt-monthly 2031-05'");
    expect(audit.rows.length).toBe(1);
  });

  it('empty month gives rows []; December works', async () => {
    expect(await (await get('?month=2030-01')).json()).toEqual({ month: '2030-01', rows: [] });
    await formF('2031-12-15T05:00:00Z');
    expect(((await (await get('?month=2031-12')).json()) as { rows: unknown[] }).rows.length).toBe(1);
  });

  it('403 for a doctor; 422 for a missing, malformed or impossible month or extra query', async () => {
    expect((await get('?month=2031-05', doctor)).status).toBe(403);
    for (const q of ['', '?month=2031-13', '?month=2031-00', '?month=2031-5', '?month=abc', '?month=2031-05&x=1']) expect((await get(q)).status, q).toBe(422);
  });
});

describe('GET /admin/registers/notifiable-diseases', () => {
  const get = (q: string, who = admin) => app.request(`/admin/registers/notifiable-diseases${q}`, {}, who);

  it('lists notifiable diagnoses in the India-time range, by date; skips others and voided', async () => {
    const malaria = await diagnosis('2032-03-01T05:00:00Z', 'B50.9');
    const tb = await diagnosis('2032-03-02T05:00:00Z', 'a15.0');
    const dengueEdge = await diagnosis('2032-03-04T18:29:59Z', 'A91'); // 4 March 23:59 IST
    await diagnosis('2032-03-04T18:30:00Z', 'A91'); // 5 March IST: out
    await diagnosis('2032-02-29T18:29:59Z', 'B50'); // 29 Feb IST: out
    await diagnosis('2032-03-02T05:00:00Z', 'J18.9'); // not notifiable
    await diagnosis('2032-03-02T05:00:00Z', 'A83.1'); // only A83.0 is listed
    await diagnosis('2032-03-02T06:00:00Z', 'B50.9', { voided: true });
    const res = await get('?from=2032-03-01&to=2032-03-04');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { date: string; icd10: string; disease: string; patientId: string; uhid: string; patientName: string; diagnosisText: string; kind: string }[];
    expect(rows.map((r) => [r.date, r.icd10, r.disease])).toEqual([
      ['2032-03-01', 'B50.9', 'Malaria'],
      ['2032-03-02', 'a15.0', 'Tuberculosis'],
      ['2032-03-04', 'A91', 'Dengue'],
    ]);
    expect(rows[0]).toMatchObject({ patientId: kavita, diagnosisText: 'Dx text', kind: 'final' });
    expect(rows[0]?.uhid).toBeTruthy();
    expect(rows[0]?.patientName).toBeTruthy();
    expect([malaria, tb, dengueEdge].length).toBe(3);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'register' AND record_id = 'notifiable-diseases 2032-03-01..2032-03-04'");
    expect(audit.rows.length).toBe(1);
  });

  it('empty range gives []', async () => {
    expect(await (await get('?from=2029-01-01&to=2029-01-31')).json()).toEqual([]);
  });

  it('403 for a doctor; 422 for missing, reversed, over-long or malformed range', async () => {
    expect((await get('?from=2032-03-01&to=2032-03-02', doctor)).status).toBe(403);
    for (const q of ['', '?from=2032-03-01', '?to=2032-03-01', '?from=2032-03-05&to=2032-03-01', '?from=2032-03-01&to=2033-03-02', '?from=x&to=2032-03-01', '?from=2032-03-01&to=2032-03-02&y=1'])
      expect((await get(q)).status, q).toBe(422);
    expect((await get('?from=2032-01-01&to=2032-12-31')).status).toBe(200); // 366 days
  });
});
