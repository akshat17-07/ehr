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

describe('GET /staff/tariffs', () => {
  type T = { code: string; nameEn: string; pricePaise: number; setting: string; validFrom: string; validTo?: string };
  const codes = async (query = '') => ((await get(`/tariffs${query}`)).body as T[]).map((t) => t.code);

  it('lists the prices in force today, A to Z, with paise, GST and dates', async () => {
    const all = (await get('/tariffs')).body as T[];
    expect(all).toHaveLength(10);
    expect(all.map((t) => t.nameEn)).toEqual([...all.map((t) => t.nameEn)].sort());
    expect(all.find((t) => t.code === 'OPD-GEN')).toMatchObject({ pricePaise: 30000, gstRate: 0, setting: 'opd', validFrom: '2024-04-01' });
    expect(all.find((t) => t.code === 'OPD-GEN')).not.toHaveProperty('validTo');
  });

  it('filters by setting (with "both"), department and code or name', async () => {
    const opd = await codes('?setting=opd');
    expect(opd).toContain('OPD-GEN');
    expect(opd).toContain('LAB-CBC');
    expect(opd).not.toContain('IPD-GEN');
    const lab = String((await db.query("SELECT id FROM departments WHERE code = 'LAB'")).rows[0]?.id);
    expect((await codes(`?departmentId=${lab}`)).sort()).toEqual(['LAB-CBC', 'LAB-RBS']);
    expect(await codes('?q=x-ray')).toEqual(['RAD-XRC']);
    expect(await codes('?q=ipd-p')).toEqual(['IPD-PVT']);
    expect(await codes('?q=' + encodeURIComponent('अल्ट्रा'))).toEqual(['RAD-USG']);
  });

  it('gives the prices in force on another date', async () => {
    await db.query("UPDATE tariffs SET valid_to = '2026-03-31' WHERE code = 'LAB-RBS'");
    await db.query(
      `INSERT INTO tariffs (id, status, created_by, updated_by, list_version, code, name_en, price_paise, gst_rate, setting, valid_from)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', 2, 'LAB-RBS', 'Random blood sugar', 12000, 0, 'both', '2026-04-01')`,
    );
    const price = async (on: string) => ((await get(`/tariffs?q=lab-rbs&on=${on}`)).body as T[]).map((t) => t.pricePaise);
    expect(await price('2026-03-31')).toEqual([10000]);
    expect(await price('2026-04-01')).toEqual([12000]);
    expect(await price('2024-03-31')).toEqual([]);
    expect((await get('/tariffs?on=31-03-2026')).status).toBe(422);
  });
});
