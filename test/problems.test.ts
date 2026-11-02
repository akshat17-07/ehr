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
const irfan = seedId('9a710000', 3);
const list = async (patient: string, query = '', who = doctor) => {
  const res = await app.request(`/staff/patients/${patient}/problems${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as { text: string; status: string; onset?: string; resolvedAt?: string }[] };
};

describe('GET /staff/patients/{id}/problems', () => {
  it('lists active problems first, then resolved; filters by active', async () => {
    const { status, body } = await list(irfan);
    expect(status).toBe(200);
    expect(body).toMatchObject([
      { text: 'Hypertension', status: 'active', icd10: 'I10', onset: '2019-06-01' },
      { text: 'Dengue', status: 'resolved', resolvedAt: '2023-08-24' },
    ]);
    expect((await list(irfan, '?active=true')).body.map((p) => p.text)).toEqual(['Hypertension']);
    expect((await list(irfan, '?active=false')).body.map((p) => p.text)).toEqual(['Dengue']);
    expect((await list(seedId('9a710000', 1))).body).toEqual([]);
  });

  it('422 for a bad filter; 404 for no such patient; 403 for a GP', async () => {
    expect((await list(irfan, '?active=1')).status).toBe(422);
    expect((await list(seedId('9a710000', 999))).status).toBe(404);
    expect((await list(irfan, '', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/patients/{id}/problems', () => {
  const rahul = seedId('9a710000', 5);
  const add = (patient: string, body: unknown, who = doctor) =>
    app.request(`/staff/patients/${patient}/problems`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('adds an active problem, the code upper-cased', async () => {
    const res = await add(rahul, { text: 'Type 2 diabetes', icd10: 'e11.9', onset: '2021-03-01' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: rahul, text: 'Type 2 diabetes', icd10: 'E11.9', onset: '2021-03-01', status: 'active', createdBy: 'dev-doctor' });
    expect((await add(rahul, { text: 'Asthma' })).status).toBe(201);
    expect((await list(rahul)).body.map((p) => p.text)).toEqual(['Type 2 diabetes', 'Asthma']);
  });

  it('409 if already active (same code or same text); a resolved one may come back', async () => {
    expect(await (await add(rahul, { text: 'Diabetes', icd10: 'E11.9' })).json()).toMatchObject({ error: 'already_recorded' });
    expect(await (await add(rahul, { text: 'asthma' })).json()).toMatchObject({ error: 'already_recorded' });
    expect((await add(irfan, { text: 'Dengue again', icd10: 'A90' })).status).toBe(201);
  });

  it('422 for an unknown code, a future onset or a bad body; 404 for no patient; 403 for a nurse', async () => {
    expect((await add(rahul, { text: 'Something', icd10: 'Z99.99' })).status).toBe(422);
    expect((await add(rahul, { text: 'Something', onset: '2999-01-01' })).status).toBe(422);
    expect((await add(rahul, { text: 'Something', extra: 1 })).status).toBe(422);
    expect((await add(seedId('9a710000', 999), { text: 'Something' })).status).toBe(404);
    expect((await add(rahul, { text: 'Something' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/problems/{id}/resolve', () => {
  const hypertension = seedId('9b0b0000', 1);
  const resolve = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/problems/${id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('422 for a future date, a date before onset or a bad body; 403 for a nurse; 404 for none', async () => {
    expect((await resolve(hypertension, { resolvedAt: '2999-01-01' })).status).toBe(422);
    expect((await resolve(hypertension, { resolvedAt: '2019-05-31' })).status).toBe(422);
    expect((await resolve(hypertension, { when: 'now' })).status).toBe(422);
    expect((await resolve(hypertension, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await resolve(seedId('9b0b0000', 999), {})).status).toBe(404);
    expect((await resolve('nope', {})).status).toBe(404);
  });

  it('resolves with a date and note; 409 when already resolved', async () => {
    const res = await resolve(hypertension, { resolvedAt: '2026-10-01', note: 'BP normal off medicines for 6 months' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'resolved', resolvedAt: '2026-10-01', onset: '2019-06-01', version: 2, updatedBy: 'dev-doctor' });
    expect((await list(irfan, '?active=true')).body.map((p) => p.text)).not.toContain('Hypertension');
    const history = await db.query('SELECT reason FROM problems_versions WHERE record_id = $1', [hypertension]);
    expect(history.rows).toEqual([{ reason: 'BP normal off medicines for 6 months' }]);
    expect(await (await resolve(hypertension, {})).json()).toMatchObject({ error: 'resolved' });
  });
});
