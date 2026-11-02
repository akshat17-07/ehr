import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const medical = asStaff('dev-medical', ['medical']);
const reception = asStaff('dev-reception', ['staff']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);
const rahul = seedId('9a710000', 5);
const med = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);
const paracetamol = { drugId: seedId('d0000000', 1), drugText: 'Paracetamol 500 mg', dose: '1 tab', frequency: 'TDS', days: 3, quantity: 9 };

const prescribe = async (encounterId: string) =>
  ((await (await app.request(`/staff/encounters/${encounterId}/prescriptions`, json({ lines: [paracetamol] }), doctor)).json()) as { id: string }).id;
const opdEncounter = ((await (await app.request('/staff/encounters', json({ patientId: irfan, type: 'OPD', departmentId: med, doctorId }), doctor)).json()) as { id: string }).id;
const admission = (await (await app.request('/staff/admissions', json({ patientId: rahul, departmentId: med, doctorId, ward: 'General Ward A', bed: '7' }), doctor)).json()) as { encounterId: string };

describe('GET /staff/pharmacy/queue', () => {
  const queue = (query = '', who = medical) => app.request(`/staff/pharmacy/queue${query}`, {}, who);
  type Queued = { id: string; setting: string; status: string; patient: { id: string; name: string } };

  it("lists today's confirmed prescriptions, oldest first, with the patient and setting", async () => {
    const opd = await prescribe(opdEncounter);
    const ipd = await prescribe(admission.encounterId);
    const res = await queue();
    expect(res.status).toBe(200);
    const items = (await res.json()) as Queued[];
    expect(items.map((p) => p.id)).toEqual([opd, ipd]);
    expect(items[0]).toMatchObject({ status: 'confirmed', setting: 'opd', patient: { id: irfan } });
    expect(items[1]).toMatchObject({ setting: 'ipd', patient: { id: rahul } });
    expect(((await (await queue('?setting=ipd')).json()) as Queued[]).map((p) => p.id)).toEqual([ipd]);
    expect(((await (await queue('?setting=opd')).json()) as Queued[]).map((p) => p.id)).toEqual([opd]);
    expect(((await (await queue(`?date=${indiaDate(new Date(Date.now() - 86_400_000))}`)).json()) as Queued[])).toEqual([]);
  });

  it('leaves out voided and dispensed prescriptions', async () => {
    const voided = await prescribe(opdEncounter);
    await app.request(`/staff/prescriptions/${voided}/void`, json({ reason: 'wrong drug' }), doctor);
    const dispensed = await prescribe(opdEncounter);
    await db.query("UPDATE prescriptions SET status = 'dispensed' WHERE id = $1", [dispensed]);
    const ids = ((await (await queue()).json()) as Queued[]).map((p) => p.id);
    expect(ids).not.toContain(voided);
    expect(ids).not.toContain(dispensed);
  });

  it('422 for a bad setting or date; 403 for reception', async () => {
    expect((await queue('?setting=er')).status).toBe(422);
    expect((await queue('?date=2026-13-01')).status).toBe(422);
    expect((await queue('', reception)).status).toBe(403);
  });
});
