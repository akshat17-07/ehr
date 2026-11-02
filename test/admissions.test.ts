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
const doctor = asStaff('dev-doctor', ['doctor']);
const nurse = asStaff('dev-nurse', ['nurse']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);
const kavita = seedId('9a710000', 4);
const med = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);

const admit = (body: Record<string, unknown>, who = doctor) =>
  app.request('/staff/admissions', json({ departmentId: med, doctorId, ward: 'General Ward A', ...body }), who);

describe('POST /staff/admissions', () => {
  it('admits to a bed and opens the IPD encounter', async () => {
    const res = await admit({ patientId: irfan, bed: '1', reason: 'Dengue with low platelets' });
    expect(res.status).toBe(201);
    const admission = (await res.json()) as { encounterId: string };
    expect(admission).toMatchObject({ patientId: irfan, ward: 'General Ward A', bed: '1', status: 'current', doctorId, departmentId: med });
    const encounter = await app.request(`/staff/encounters/${admission.encounterId}`, {}, doctor);
    expect(await encounter.json()).toMatchObject({ type: 'IPD', status: 'open', patientId: irfan });
    const timeline = await app.request(`/staff/patients/${irfan}/timeline?kind=admission`, {}, doctor);
    expect(((await timeline.json()) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(['Admitted: General Ward A, bed 1']);
  });

  it('409 if already admitted or the bed is taken (ward case ignored)', async () => {
    expect(await (await admit({ patientId: irfan, bed: '9' })).json()).toMatchObject({ error: 'already_admitted' });
    expect(await (await admit({ patientId: kavita, bed: '1', ward: 'general ward a' })).json()).toMatchObject({ error: 'bed_taken' });
    expect((await admit({ patientId: kavita, bed: '2' })).status).toBe(201);
  });

  it('422 for an unknown patient, a doctor outside the department or a bad body; 403 for a nurse', async () => {
    expect((await admit({ patientId: seedId('9a710000', 999), bed: '3' })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '3', doctorId: seedId('a0000000', 4) })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '' })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '3' }, nurse)).status).toBe(403);
    expect((await db.query('SELECT count(*)::int AS n FROM encounters WHERE type = $1', ['IPD'])).rows[0]?.n).toBe(2);
  });
});
