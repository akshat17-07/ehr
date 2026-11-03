import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { MERGE_MOVES, MERGE_STAYS } from '../src/modules/patients/merges.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const admin = asStaff('dev-admin', ['admin']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patient = (n: number) => seedId('9a710000', n);
let made = 0;
/** A new patient of its own, so no test shares a merge with another. */
async function newPatient(): Promise<string> {
  made += 1;
  const { rows } = await db.query(
    `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, labels, allergies)
     VALUES (gen_random_uuid(), 'active', 'dev-admin', 'dev-admin', $1, 'Merge Test', 'merge test', 'F', '[]', '[]') RETURNING id`,
    [`U99${String(made).padStart(6, '0')}`],
  );
  return String(rows[0]!.id);
}

async function propose(keep: string, merge: string, who = head) {
  const res = await app.request('/staff/patient-merges', json({ keepPatientId: keep, mergePatientId: merge, reason: 'Same person, two UHIDs' }), who);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const decide = async (id: string, verb: 'approve' | 'reject', body: unknown = {}, who = admin) => {
  const res = await app.request(`/admin/patient-merges/${id}/${verb}`, json(body), who);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { movedCounts?: Record<string, number> } };
};
const row = async (table: string, id: string) => (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]!;

describe('every table with a patient_id is either moved or left on purpose', () => {
  it('lists them all', async () => {
    const { rows } = await db.query("SELECT DISTINCT table_name FROM information_schema.columns WHERE column_name = 'patient_id' AND table_schema = 'public'");
    const known = new Set<string>([...MERGE_MOVES, ...MERGE_STAYS]);
    const tables = rows.map((r) => String(r.table_name)).filter((t) => !t.endsWith('_versions'));
    expect(tables.filter((t) => !known.has(t))).toEqual([]);
    for (const t of MERGE_MOVES) expect(tables).toContain(t);
  });
});

describe('POST /admin/patient-merges/{id}/approve', () => {
  it('moves the records, folds in the labels and allergies, and points the other UHID at the kept one', async () => {
    const keep = patient(1);
    const gone = patient(2);
    await db.query(`UPDATE patients SET labels = '["hiv"]', allergies = '["Sulfa","penicillin"]' WHERE id = $1`, [gone]);
    const bill = (await (await app.request('/staff/bills', json({ patientId: gone, lines: [{ text: 'Package', qty: 1, unitPaise: 1000 }] }), doctor)).json()) as { id: string };
    const stayId = randomUUID();
    await db.query(
      `INSERT INTO access_requests (id, status, created_by, updated_by, patient_id, requested_by, reason) VALUES ($1, 'pending', 'dev-nurse', 'dev-nurse', $2, 'dev-nurse', 'follow-up')`,
      [stayId, gone],
    );
    // a guardian row of the merged patient, and a patient whose guardian is the merged patient
    const guardian = randomUUID();
    const guardedBy = randomUUID();
    await db.query(
      `INSERT INTO guardians (id, status, created_by, updated_by, patient_id, name, relation) VALUES ($1, 'active', 'dev-admin', 'dev-admin', $2, 'Ramesh', 'father')`,
      [guardian, gone],
    );
    await db.query(
      `INSERT INTO guardians (id, status, created_by, updated_by, patient_id, guardian_patient_id, name, relation) VALUES ($1, 'active', 'dev-admin', 'dev-admin', $2, $3, 'Sita', 'mother')`,
      [guardedBy, patient(3), gone],
    );
    const id = await propose(keep, gone);

    const { status, body } = await decide(id, 'approve', { note: 'confirmed by phone' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'approved', keepPatientId: keep, mergePatientId: gone, approvedBy: 'dev-admin' });
    expect(body.movedCounts).toEqual({ bills: 1, guardians: 1, 'guardians.guardian_patient_id': 1 });
    expect((await row('bills', bill.id)).patient_id).toBe(keep);
    expect((await row('guardians', guardian)).patient_id).toBe(keep);
    expect((await row('guardians', guardedBy)).guardian_patient_id).toBe(keep);
    // the ids of the moved rows are kept on the merge, to audit or undo it
    expect(JSON.parse(String((await row('patient_merges', id)).moved_rows))).toEqual({
      bills: [bill.id],
      guardians: [guardian],
      'guardians.guardian_patient_id': [guardedBy],
    });
    expect((await row('access_requests', stayId)).patient_id).toBe(gone);
    const kept = await row('patients', keep);
    expect(JSON.parse(String(kept.labels))).toEqual(['hiv']);
    // "penicillin" is on both (any case): kept once
    expect(JSON.parse(String(kept.allergies))).toEqual(['Penicillin', 'Sulfa']);
    expect(kept.merged_into).toBeNull();
    expect((await row('patients', gone)).merged_into).toBe(keep);
    const history = await db.query('SELECT reason FROM patient_merges_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'confirmed by phone' });

    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await decide(id, 'reject', { reason: 'changed my mind' })).status).toBe(409);
  });

  it('403 for the proposer or without patient.merge; 404; the merge stays pending', async () => {
    const [a, b] = [await newPatient(), await newPatient()];
    const id = await propose(a, b);
    expect((await decide(id, 'approve', {}, head)).status).toBe(403);
    expect((await decide(id, 'approve', {}, doctor)).status).toBe(403);
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'approve')).status).toBe(404);
    expect((await row('patient_merges', id)).status).toBe('pending');
    expect((await row('patients', b)).merged_into).toBeNull();
  });

  it('409 if a patient was merged into someone else meanwhile; nothing moves', async () => {
    const [a, b, other] = [await newPatient(), await newPatient(), await newPatient()];
    const id = await propose(a, b);
    await db.query('UPDATE patients SET merged_into = $2 WHERE id = $1', [b, other]);
    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await row('patient_merges', id)).status).toBe('pending');
  });
});

describe('POST /admin/patient-merges/{id}/reject', () => {
  it('rejects: nothing moves, the reason is kept', async () => {
    const [a, b] = [await newPatient(), await newPatient()];
    const id = await propose(a, b, admin);
    const bill = (await (await app.request('/staff/bills', json({ patientId: b, lines: [{ text: 'Package', qty: 1, unitPaise: 1000 }] }), doctor)).json()) as { id: string };
    const { status, body } = await decide(id, 'reject', { reason: 'different people' }, head);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'rejected' });
    expect((await row('bills', bill.id)).patient_id).toBe(b);
    expect((await row('patients', b)).merged_into).toBeNull();
    const history = await db.query('SELECT reason FROM patient_merges_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'different people' });
  });

  it('422 for a short or missing reason; 403 for the proposer or without patient.merge', async () => {
    const id = await propose(await newPatient(), await newPatient());
    expect((await decide(id, 'reject', { reason: 'no' })).status).toBe(422);
    expect((await decide(id, 'reject', {})).status).toBe(422);
    expect((await decide(id, 'reject', { reason: 'different people' }, head)).status).toBe(403);
    expect((await decide(id, 'reject', { reason: 'different people' }, doctor)).status).toBe(403);
    expect((await row('patient_merges', id)).status).toBe('pending');
  });
});
