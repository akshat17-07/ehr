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
