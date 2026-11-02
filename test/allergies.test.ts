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

