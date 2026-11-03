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
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);

let made = 0;
async function newPatient(labels: string[] = []): Promise<string> {
  made += 1;
  const { rows } = await db.query(
    `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, labels, allergies)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, 'Label Test', 'label test', 'F', $2, '[]') RETURNING id`,
    [`U97${String(made).padStart(6, '0')}`, JSON.stringify(labels)],
  );
  return String(rows[0]!.id);
}
const post = async (id: string, body: unknown, who = admin) => {
  const res = await app.request(`/admin/patients/${id}/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  return { status: res.status, body: (await res.json()) as { labels: string[]; version: number } };
};

describe('POST /admin/patients/{id}/labels', () => {
  it('adds and removes labels in one go, returning the patient; the old labels are kept in history', async () => {
    const id = await newPatient(['mtp']);
    const { status, body } = await post(id, { add: ['hiv', 'mental_health'], remove: ['mtp'], reason: 'Counselling notes' }, head);
    expect(status).toBe(200);
    expect(body).toMatchObject({ labels: ['hiv', 'mental_health'], version: 2 });
    const history = await db.query('SELECT data, reason FROM patients_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'Counselling notes' });
    const old = typeof history.rows[0]!.data === 'string' ? JSON.parse(history.rows[0]!.data) : history.rows[0]!.data;
    expect(JSON.parse(String((old as { labels: string }).labels))).toEqual(['mtp']);
    expect((await post(id, { add: ['pcpndt'], reason: 'Form F filed' })).body.labels).toEqual(['pcpndt', 'hiv', 'mental_health']);
  });

  it('422 for nothing to change, a label both added and removed, an unknown label or a short reason', async () => {
    const id = await newPatient(['hiv']);
    expect((await post(id, { add: ['hiv'], reason: 'Already there' })).status).toBe(422);
    expect((await post(id, { remove: ['mtp'], reason: 'Not there' })).status).toBe(422);
    expect((await post(id, { add: ['mtp'], remove: ['mtp'], reason: 'Both ways' })).status).toBe(422);
    expect((await post(id, { add: ['cancer'], reason: 'Unknown label' })).status).toBe(422);
    expect((await post(id, { reason: 'No labels given' })).status).toBe(422);
    expect((await post(id, { add: ['mtp'], reason: 'no' })).status).toBe(422);
    expect((await post(id, { add: ['mtp'] })).status).toBe(422);
    expect((await post(id, { remove: ['hiv'], reason: 'Wrongly labelled' })).body.labels).toEqual([]);
  });

  it('403 without sensitive.label; 404 for none; 409 for a merged patient; the change is audited', async () => {
    const id = await newPatient();
    expect((await post(id, { add: ['mtp'], reason: 'Not allowed' }, doctor)).status).toBe(403);
    expect((await post(randomUUID(), { add: ['mtp'], reason: 'No such patient' })).status).toBe(404);
    expect((await post('nope', { add: ['mtp'], reason: 'No such patient' })).status).toBe(404);
    await db.query('UPDATE patients SET merged_into = $2 WHERE id = $1', [id, await newPatient()]);
    expect((await post(id, { add: ['mtp'], reason: 'Merged away' })).status).toBe(409);

    const other = await newPatient();
    await post(other, { add: ['pcpndt'], reason: 'Form F filed' });
    const audit = await db.query("SELECT action, reason, changes FROM audit_events WHERE patient_id = $1 AND record_type = 'patient'", [other]);
    expect(audit.rows[0]).toMatchObject({ action: 'update', reason: 'Form F filed' });
    expect(JSON.parse(String(audit.rows[0]!.changes))).toEqual({ labels: [[], ['pcpndt']] });
  });
});

describe('a labelled record is opened only with the label permission', () => {
  const doctorId = seedId('a0000000', 3);
  const med = seedId('de000000', 1);
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

  /** A recently active patient with these labels and an encounter (a clinical read: GET /staff/encounters/{id}). */
  async function labelled(labels: string[]) {
    const patientId = await newPatient(labels);
    await db.query('UPDATE patients SET last_activity_at = now() WHERE id = $1', [patientId]);
    const { rows } = await db.query(
      `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at)
       VALUES (gen_random_uuid(), 'closed', 'x', 'x', $1, 'OPD', $2, $3, now()) RETURNING id`,
      [patientId, med, doctorId],
    );
    return { patientId, encounterId: String(rows[0]!.id) };
  }
  const read = async (encounterId: string, who = doctor) => {
    const res = await app.request(`/staff/encounters/${encounterId}`, {}, who);
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };
  const give = async (permission: string, scope = 'all', scopeId?: string) => {
    const res = await app.request(
      '/admin/grants',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: doctorId, permission, scope, ...(scopeId && { scopeId }), end: hours(2), reason: 'Care of this patient' }) },
      admin,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const revoke = async (id: string) =>
    app.request(`/admin/grants/${id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Done with it' }) }, admin);

  it('an unlabelled patient opens as before; a doctor is refused a labelled one; Admin too, without a grant', async () => {
    expect((await read((await labelled([])).encounterId)).status).toBe(200);
    const { encounterId } = await labelled(['hiv']);
    expect(await read(encounterId)).toEqual({ status: 403, error: 'sensitive_record' });
    expect(await read(encounterId, admin)).toEqual({ status: 403, error: 'sensitive_record' });
  });

  it('a grant of the matching permission opens it; every label must be covered', async () => {
    const hiv = await labelled(['hiv', 'mental_health']);
    const both = await labelled(['hiv', 'mtp']);
    const grant = await give('sensitive.view');
    expect((await read(hiv.encounterId)).status).toBe(200);
    expect(await read(both.encounterId)).toEqual({ status: 403, error: 'sensitive_record' });
    const mtp = await give('mtp.view');
    expect((await read(both.encounterId)).status).toBe(200);
    await revoke(mtp);
    expect((await read(both.encounterId)).status).toBe(403);
    await revoke(grant);
    expect((await read(hiv.encounterId)).status).toBe(403);
  });

  it('a grant for one patient opens only that patient', async () => {
    const mine = await labelled(['pcpndt']);
    const other = await labelled(['pcpndt']);
    const grant = await give('pcpndt.view', 'patient', mine.patientId);
    expect((await read(mine.encounterId)).status).toBe(200);
    expect((await read(other.encounterId)).status).toBe(403);
    await revoke(grant);
    expect((await read(mine.encounterId)).status).toBe(403);
  });

  it('break-glass opens a labelled record', async () => {
    const { patientId, encounterId } = await labelled(['mental_health']);
    expect((await read(encounterId)).status).toBe(403);
    const res = await app.request(`/staff/patients/${patientId}/break-glass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Overdose in casualty' }) }, doctor);
    expect(res.status).toBe(201);
    expect((await read(encounterId)).status).toBe(200);
  });
});
