import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const nurse = asStaff('dev-nurse', ['nurse']);
const get = async (path: string, who = nurse) => {
  const res = await app.request(`/staff${path}`, {}, who);
  return { status: res.status, body: (await res.json()) as never };
};

describe('GET /staff/hospital', () => {
  it('gives the hospital details to any staff member', async () => {
    expect(await get('/hospital')).toMatchObject({
      status: 200,
      body: {
        name: 'Shanti Multispeciality Hospital',
        address: { city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462011' },
        licenceValidTill: '2029-03-31',
        invoicePrefix: 'INV',
        billOfSupplyPrefix: 'BOS',
      },
    });
    expect((await get('/hospital', asStaff('dev-medical', ['medical']))).status).toBe(200);
  });

  it('is blank but present in a new database', async () => {
    const empty = await openLocalDb();
    const res = await createApp({ db: async () => empty }).request('/staff/hospital', {}, asStaff('someone', ['staff']));
    const body = await res.json();
    expect(body).toMatchObject({ name: '', address: { state: 'Madhya Pradesh' }, invoicePrefix: 'INV' });
    expect(body).not.toHaveProperty('licenceValidTill');
  });
});
