import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const doctor = asStaff('dev-doctor', ['doctor']);
const ramesh = seedId('9a710000', 1);
const irfan = seedId('9a710000', 3);
const list = async (patient: string, query = '', who = doctor) => {
  const res = await app.request(`/staff/patients/${patient}/allergies${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as { substance: string; status: string }[] };
};
const add = (patient: string, body: unknown, who = doctor) =>
  app.request(`/staff/patients/${patient}/allergies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const banner = async (patient: string) =>
  ((await (await app.request(`/staff/patients/${patient}`, {}, doctor)).json()) as { allergies: string[] }).allergies;

describe('GET /staff/patients/{id}/allergies', () => {
  it("lists the patient's allergies", async () => {
    const { status, body } = await list(ramesh);
    expect(status).toBe(200);
    expect(body).toMatchObject([{ substance: 'Penicillin', severity: 'moderate', reaction: 'Rash', status: 'active' }]);
    expect((await list(irfan)).body).toEqual([]);
  });

  it('422 for a bad includeVoid; 404 for no such patient; 403 for a GP', async () => {
    expect((await list(ramesh, '?includeVoid=yes')).status).toBe(422);
    expect((await list(seedId('9a710000', 999))).status).toBe(404);
    expect((await list(ramesh, '', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/patients/{id}/allergies', () => {
  it('records an allergy, linked to a drug, and adds it to the banner list', async () => {
    const drugId = seedId('d0000000', 1);
    const res = await add(irfan, { substance: 'Sulfa drugs', drugId, reaction: 'Hives', severity: 'severe' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: irfan, substance: 'Sulfa drugs', drugId, severity: 'severe', createdBy: 'dev-doctor' });
    expect(await banner(irfan)).toEqual(['Sulfa drugs']);
  });

  it('409 for the same substance again; 422 for an unknown drug or severity; 403 for a nurse', async () => {
    expect(await (await add(ramesh, { substance: 'penicillin', severity: 'mild' })).json()).toMatchObject({ error: 'already_recorded' });
    expect((await add(ramesh, { substance: 'Peanuts', drugId: seedId('d0000000', 999), severity: 'mild' })).status).toBe(422);
    expect((await add(ramesh, { substance: 'Peanuts', severity: 'awful' })).status).toBe(422);
    expect((await add(ramesh, { substance: 'Peanuts', severity: 'mild' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect(await banner(ramesh)).toEqual(['Penicillin']);
  });
});

describe('POST /staff/allergies/{id}/void', () => {
  const penicillin = seedId('a1e70000', 1);
  const voidIt = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/allergies/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('voids with a reason; it leaves the list and the banner but shows with includeVoid', async () => {
    expect((await voidIt(penicillin, { reason: 'no' })).status).toBe(422);
    const res = await voidIt(penicillin, { reason: 'tolerated amoxicillin course, test negative' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'voided', voidedBy: 'dev-doctor', version: 2 });
    expect((await list(ramesh)).body).toEqual([]);
    expect((await list(ramesh, '?includeVoid=true')).body.map((a) => a.status)).toEqual(['voided']);
    expect(await banner(ramesh)).toEqual([]);
    expect(await (await voidIt(penicillin, { reason: 'once more please' })).json()).toMatchObject({ error: 'voided' });
  });

  it('404 for none; 403 for a nurse', async () => {
    expect((await voidIt(seedId('a1e70000', 999), { reason: 'not real' })).status).toBe(404);
    expect((await voidIt(penicillin, { reason: 'not real' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});
