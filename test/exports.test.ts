import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
/** What the fake exports bucket holds, by key. */
const exported = new Map<string, string>();
let bucketDown = false;
const app = createApp({
  db: async () => db,
  exportFiles: {
    put: async (key, body) => {
      if (bucketDown) throw new Error('S3 down');
      exported.set(key, body);
    },
  },
  signUrl: async (bucket, key, seconds) => `https://s3.test/${bucket}/${key}?get=${seconds}`,
});

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const irfan = seedId('9a710000', 3);
const post = (path: string, body: unknown = {}, who = doctor) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('POST /staff/fhir/Patient/{id}/$export', () => {
  it('writes the patient as a FHIR bundle with visits and diagnoses', async () => {
    const visit = (await (await post('/staff/encounters', { patientId: irfan, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) })).json()) as { id: string };
    await db.query(`INSERT INTO diagnoses (id, status, created_by, updated_by, encounter_id, patient_id, icd10, text, kind) VALUES ($1, 'active', 'test', 'test', $2, $3, 'E11.9', 'Type 2 diabetes', 'final')`, [
      randomUUID(), visit.id, irfan,
    ]);
    const res = await post(`/staff/fhir/Patient/${irfan}/$export`);
    expect(res.status).toBe(202);
    const made = (await res.json()) as { id: string; finishedAt: string };
    expect(made).toMatchObject({ status: 'done', kind: 'patient', patientId: irfan, createdBy: 'dev-doctor' });
    expect(made).not.toHaveProperty('s3Key');
    const body = [...exported].find(([k]) => k === `fhir/${irfan}/${made.id}.json`)![1];
    const bundle = JSON.parse(body) as { resourceType: string; type: string; entry: { resource: Record<string, unknown> }[] };
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
    const kinds = bundle.entry.map((e) => e.resource.resourceType);
    expect(kinds[0]).toBe('Patient');
    expect(bundle.entry[0]!.resource).toMatchObject({ id: irfan, gender: 'male' });
    expect(bundle.entry.find((e) => e.resource.resourceType === 'Encounter' && e.resource.id === visit.id)?.resource).toMatchObject({ status: 'in-progress', class: { code: 'AMB' } });
    expect(bundle.entry.find((e) => e.resource.resourceType === 'Condition')?.resource).toMatchObject({
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }] },
      encounter: { reference: `Encounter/${visit.id}` },
    });
  });

  it('saves a failed export when the bucket is down; 404 for no patient; 403 for a nurse', async () => {
    bucketDown = true;
    expect((await post(`/staff/fhir/Patient/${irfan}/$export`)).status).toBe(500);
    bucketDown = false;
    const { rows } = await db.query("SELECT status, finished_at FROM exports WHERE patient_id = $1 AND status = 'failed'", [irfan]);
    expect(rows).toHaveLength(1);
    expect((await post(`/staff/fhir/Patient/${seedId('9a710000', 999)}/$export`)).status).toBe(404);
    expect((await post(`/staff/fhir/Patient/${irfan}/$export`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});
