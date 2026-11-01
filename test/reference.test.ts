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

describe('GET /staff/departments', () => {
  it('lists departments A to Z with Hindi names, and filters by active', async () => {
    const all = (await get('/departments')).body as { code: string; nameEn: string; nameHi: string; active: boolean }[];
    expect(all).toHaveLength(9);
    expect(all.map((d) => d.nameEn)).toEqual([...all.map((d) => d.nameEn)].sort());
    expect(all.find((d) => d.code === 'MED')).toMatchObject({ nameHi: expect.any(String), active: true });

    await db.query("UPDATE departments SET active = false WHERE code = 'DEN'");
    const active = (await get('/departments?active=true')).body as { code: string }[];
    expect(active.map((d) => d.code)).not.toContain('DEN');
    expect(((await get('/departments?active=false')).body as { code: string }[]).map((d) => d.code)).toEqual(['DEN']);
    expect((await get('/departments?active=yes')).status).toBe(422);
  });
});
