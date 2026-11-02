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

describe('POST /staff/encounters/{id}/form-f', () => {
  const write = (id: string, body: unknown, who = doctor) => app.request(`/staff/encounters/${id}/form-f`, json(body), who);
  const form = { indication: 'Anomaly scan at 20 weeks', procedure: 'Ultrasound, obstetric', declarationSigned: true };
  const openFor = async (patientId: string) =>
    ((await (await app.request('/staff/encounters', json({ patientId, type: 'OPD', departmentId: MED, doctorId: seedId('a0000000', 3) }), doctor)).json()) as { id: string }).id;

  it('writes the form once per encounter, signed by the doctor', async () => {
    const id = await openFor(kavita);
    const res = await write(id, form);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ encounterId: id, patientId: kavita, doctorId: seedId('a0000000', 3), declarationSigned: true, version: 1 });
    expect(await (await write(id, form)).json()).toMatchObject({ error: 'already_written' });
  });

  it('422 fetal_sex_forbidden for any sex field, whatever its value', async () => {
    const id = await openFor(kavita);
    for (const key of ['fetalSex', 'sex', 'gender', 'babyGender']) {
      expect(await (await write(id, { ...form, [key]: 'not told' })).json()).toMatchObject({ error: 'fetal_sex_forbidden' });
    }
    expect((await db.query('SELECT count(*)::int AS n FROM form_f WHERE encounter_id = $1', [id])).rows[0]).toEqual({ n: 0 });
  });

  it('422 without the declaration or for a male patient; 403 without a grant; 404 for no encounter', async () => {
    const id = await openFor(kavita);
    expect((await write(id, { ...form, declarationSigned: false })).status).toBe(422);
    expect((await write(await openFor(seedId('9a710000', 5)), form)).status).toBe(422);
    expect((await write(id, form, surgeon)).status).toBe(403);
    expect((await write(seedId('e0000000', 999), form)).status).toBe(404);
  });
});
