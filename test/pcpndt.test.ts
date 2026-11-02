import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { createGrant } from '../src/permissions/grants.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const surgeon = asStaff('dev-surgeon', ['doctor']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const kavita = seedId('9a710000', 4);
const MED = seedId('de000000', 1);
const inAMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

// The doctor holds the PC-PNDT grants for Medicine only; the surgeon has none.
for (const permission of ['pcpndt.view', 'pcpndt.write']) {
  await createGrant(db, { userId: 'dev-doctor', permission, scope: 'department', scopeId: MED, end: inAMonth(), grantorId: 'dev-admin', reason: 'Sonologist on the MED roster' });
}
const opened = await app.request('/staff/encounters', json({ patientId: kavita, type: 'OPD', departmentId: MED, doctorId: seedId('a0000000', 3) }), doctor);
const encounterId = ((await opened.json()) as { id: string }).id;

describe('GET /staff/encounters/{id}/form-f', () => {
  const get = (id: string, who = doctor) => app.request(`/staff/encounters/${id}/form-f`, {}, who);

  it('404 until a Form F is written; returns it after', async () => {
    expect((await get(encounterId)).status).toBe(404);
    await db.query(
      `INSERT INTO form_f (id, status, created_by, updated_by, encounter_id, patient_id, doctor_id, indication, procedure, declaration_signed)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $2, $3, 'Dating scan', 'Ultrasound, obstetric', true)`,
      [encounterId, kavita, seedId('a0000000', 3)],
    );
    expect(await (await get(encounterId)).json()).toMatchObject({ encounterId, patientId: kavita, indication: 'Dating scan', procedure: 'Ultrasound, obstetric', declarationSigned: true });
  });

  it('403 without a grant for that department; 404 for no encounter', async () => {
    expect((await get(encounterId, surgeon)).status).toBe(403);
    expect((await get(seedId('e0000000', 999))).status).toBe(404);
  });
});
