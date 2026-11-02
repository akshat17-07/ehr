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
const doctor = asStaff('dev-doctor', ['doctor']);
const irfan = seedId('9a710000', 3);
const star = seedId('1a000000', 1);
const mediAssist = seedId('1b000000', 1);

/** A policy row straight in the table (POST /policies comes at #132). */
async function insertPolicy(patientId: string, policyNo: string, validFrom: string, validTo: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, holder_name, valid_from, valid_to, sum_insured_paise)
     VALUES ($1, 'active', 'test', 'test', $2, $3, $4, $5, 'Irfan Khan', $6, $7, 50000000)`,
    [id, patientId, star, mediAssist, policyNo, validFrom, validTo],
  );
  return id;
}

describe('GET /staff/patients/{id}/policies', () => {
  it('lists the policies; active picks those in force today', async () => {
    const old = await insertPolicy(irfan, 'P-OLD', '2020-01-01', '2020-12-31');
    const now = await insertPolicy(irfan, 'P-NOW', '2020-01-01', '2099-12-31');
    const res = await app.request(`/staff/patients/${irfan}/policies`, {}, doctor);
    expect(res.status).toBe(200);
    const all = (await res.json()) as { id: string }[];
    expect(all.map((p) => p.id)).toEqual([now, old]);
    expect(all[0]).toMatchObject({ patientId: irfan, insurerId: star, tpaId: mediAssist, policyNo: 'P-NOW', validFrom: '2020-01-01', validTo: '2099-12-31', sumInsuredPaise: 50000000, documentIds: [] });
    const active = (await (await app.request(`/staff/patients/${irfan}/policies?active=true`, {}, doctor)).json()) as { id: string }[];
    expect(active.map((p) => p.id)).toEqual([now]);
    const expired = (await (await app.request(`/staff/patients/${irfan}/policies?active=false`, {}, doctor)).json()) as { id: string }[];
    expect(expired.map((p) => p.id)).toEqual([old]);
  });

  it('403 for a nurse; 404 for no patient', async () => {
    expect((await app.request(`/staff/patients/${irfan}/policies`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await app.request(`/staff/patients/${seedId('9a710000', 999)}/policies`, {}, doctor)).status).toBe(404);
  });
});
