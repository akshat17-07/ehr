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
const reception = asStaff('dev-reception', ['staff']);
const doctorId = seedId('a0000000', 3);
const med = seedId('de000000', 1);
const today = indiaDate();

type Item = { patientId: string; type: string; status: string; patient: { uhid: string } };
const list = async (query = '', who = doctor) => {
  const res = await app.request(`/staff/encounters${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as { items: Item[]; nextCursor?: string } };
};
const checkIn = (n: number) => app.request(`/staff/appointments/${seedId('a9900000', n)}/check-in`, { method: 'POST' }, reception);

// Ramesh (dev-doctor, MED) then Rahul (dev-surgeon, SUR) arrive.
expect((await checkIn(1)).status).toBe(200);
expect((await checkIn(3)).status).toBe(200);

describe('GET /staff/encounters', () => {
  it("lists today's encounters in arrival order, each with the patient", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((e) => e.patient.uhid)).toEqual(['U24000001', 'U26000005']);
    expect(body.items[0]).toMatchObject({ type: 'OPD', status: 'open', doctorId, departmentId: med });
  });

  it('filters by doctor, department, type and status; pages; other days are empty', async () => {
    expect((await list(`?doctorId=${doctorId}`)).body.items.map((e) => e.patient.uhid)).toEqual(['U24000001']);
    expect((await list(`?departmentId=${seedId('de000000', 2)}`)).body.items.map((e) => e.patient.uhid)).toEqual(['U26000005']);
    expect((await list('?type=IPD')).body.items).toEqual([]);
    expect((await list('?status=closed')).body.items).toEqual([]);
    const first = await list('?limit=1');
    expect(first.body.items).toHaveLength(1);
    const second = await list(`?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e) => e.patient.uhid)).toEqual(['U26000005']);
    const tomorrow = new Date(new Date(`${today}T12:00:00+05:30`).getTime() + 86_400_000).toISOString().slice(0, 10);
    expect((await list(`?date=${tomorrow}`)).body.items).toEqual([]);
  });

  it('422 for a bad filter; 403 without encounter.view', async () => {
    expect((await list('?type=XYZ')).status).toBe(422);
    expect((await list('?date=01-11-2026')).status).toBe(422);
    expect((await list('', reception)).status).toBe(403);
  });
});
