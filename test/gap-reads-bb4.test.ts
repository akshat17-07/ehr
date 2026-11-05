import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// Task 707: GET /staff/encounters?patientId= with the same patient access check as the encounter read.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const get = async (path: string, who = admin) => {
  const res = await app.request(path, {}, who);
  return { status: res.status, body: (await res.json()) as never };
};

const patient = seedId('9a710000', 1);
const otherPatient = seedId('9a710000', 3);
const hivPatient = seedId('9a710000', 2);
await db.query(`UPDATE patients SET labels = '["hiv"]' WHERE id = $1`, [hivPatient]);

async function visit(patientId: string, startedAt: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at)
     VALUES ($1, 'closed', 'x', 'x', $2, 'OPD', $3, $4, $5)`,
    [id, patientId, seedId('de000000', 1), seedId('a0000000', 3), startedAt],
  );
  return id;
}
const a = await visit(patient, '2026-03-01T05:00:00Z');
const b = await visit(patient, '2026-04-01T05:00:00Z');
const c = await visit(otherPatient, '2026-04-01T06:00:00Z');
const h = await visit(hivPatient, '2026-04-01T07:00:00Z');

type Page = { items: { id: string; patientId: string }[] };

describe('#707 GET /staff/encounters?patientId=', () => {
  it("lists only that patient's visits, on every date, and ?date narrows it", async () => {
    const { status, body } = await get(`/staff/encounters?patientId=${patient}`);
    expect(status).toBe(200);
    expect((body as Page).items.map((i) => i.id)).toEqual([a, b]);
    const one = (await get(`/staff/encounters?patientId=${patient}&date=2026-04-01`)).body as Page;
    expect(one.items.map((i) => i.id)).toEqual([b]);
    expect(((await get(`/staff/encounters?patientId=${otherPatient}`)).body as Page).items.map((i) => i.id)).toEqual([c]);
  });

  it('is audited with the patient', async () => {
    await get(`/staff/encounters?patientId=${patient}`);
    const rows = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'encounter' AND patient_id = $1 ", [patient]);
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('403 for a sensitive-labelled patient without a grant, 404 unknown, 422 malformed, 403 without encounter.view', async () => {
    expect((await get(`/staff/encounters?patientId=${hivPatient}`)).status).toBe(403);
    expect((await get(`/staff/encounters?patientId=${randomUUID()}`)).status).toBe(404);
    expect((await get('/staff/encounters?patientId=nope')).status).toBe(422);
    expect((await get(`/staff/encounters?patientId=${patient}`, asStaff('dev-insurance', ['insurance']))).status).toBe(403);
  });

  it('the unfiltered list still shows one day (today) and is unchanged', async () => {
    const { status, body } = await get('/staff/encounters');
    expect(status).toBe(200);
    expect((body as Page).items.map((i) => i.id)).not.toContain(h);
    expect((await get('/staff/encounters?date=2026-04-01', asStaff('dev-doctor', ['doctor']))).status).toBe(200);
  });
});
