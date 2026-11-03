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

describe('GET /staff/tariffs/rate-board', () => {
  type Board = { hospital: { name: string }; rows: { nameEn?: string; nameHi?: string; pricePaise: number }[] };

  it("gives today's prices with the hospital, in both languages by default", async () => {
    const { status, body } = (await get('/tariffs/rate-board')) as { status: number; body: Board };
    expect(status).toBe(200);
    expect(body.hospital.name).toBe('Shanti Multispeciality Hospital');
    expect(body.rows.find((r) => r.nameEn === 'OPD consultation')).toEqual({ nameEn: 'OPD consultation', nameHi: 'ओपीडी परामर्श', pricePaise: 30000 });
  });

  it('gives one language when asked, using English where there is no Hindi name', async () => {
    const en = ((await get('/tariffs/rate-board?lang=en')).body as Board).rows;
    expect(en.every((r) => r.nameEn && !('nameHi' in r))).toBe(true);
    const hi = ((await get('/tariffs/rate-board?lang=hi')).body as Board).rows;
    expect(hi.every((r) => r.nameHi && !('nameEn' in r))).toBe(true);
    // The LAB-RBS row added in the test above has no Hindi name.
    expect(hi).toContainEqual({ nameHi: 'Random blood sugar', pricePaise: 12000 });
    expect((await get('/tariffs/rate-board?lang=fr')).status).toBe(422);
  });
});

describe('GET /staff/drugs', () => {
  type D = { name: string; strength?: string; schedule: string; mrpPaise?: number; active: boolean };
  const names = async (query: string) => ((await get(`/drugs${query}`)).body as D[]).map((d) => d.name);

  it('finds active drugs by part of the name, names starting with it first', async () => {
    const found = (await get('/drugs?q=para')).body as D[];
    expect(found[0]).toMatchObject({ name: 'Paracetamol', schedule: expect.any(String), active: true });
    expect((await names('?q=ce')).slice(0, 2)).toEqual(['Cefixime', 'Ceftriaxone']);
    expect(await names('?q=TAM')).toContain('Paracetamol');
    await db.query("UPDATE drugs SET active = false WHERE name = 'Cefixime'");
    expect(await names('?q=cef')).toEqual(['Ceftriaxone']);
  });

  it('filters by schedule and limits the count', async () => {
    expect(await names('?q=or&schedule=NDPS')).toEqual(['Morphine']);
    expect(await names('?q=in&limit=2')).toHaveLength(2);
  });

  it('422 without a 2-character q or with a bad schedule or limit', async () => {
    for (const q of ['', '?q=a', '?q=para&schedule=G', '?q=para&limit=0', '?q=para&limit=51']) expect((await get(`/drugs${q}`)).status).toBe(422);
  });
});

describe('GET /staff/drugs/{id}/batches', () => {
  type B = { batchNo: string; expiry: string; qtyOnHand: number; qtyQuarantined: number; qtyUsable: number; recalled: boolean };
  const drugId = async (name: string) => String((await db.query('SELECT id FROM drugs WHERE name = $1', [name])).rows[0]?.id);
  const medical = asStaff('dev-medical', ['medical']);

  it('lists batches first to expire first, with usable stock worked out', async () => {
    const { status, body } = await get(`/drugs/${await drugId('Paracetamol')}/batches`, medical);
    expect(status).toBe(200);
    expect((body as B[]).map((b) => [b.batchNo, b.qtyUsable])).toEqual([
      ['PCM2401', 0], // expired
      ['PCM2502', 280], // 300 on hand, 20 quarantined
      ['PCM2503', 500],
    ]);
    expect((body as B[])[0]).toMatchObject({ expiry: '2025-12-31', costPaise: 1200, mrpPaise: 2000, qtyOnHand: 40 });
  });

  it('gives 0 usable for a recalled batch, and filters by stock', async () => {
    const amx = await drugId('Amoxicillin');
    const all = (await get(`/drugs/${amx}/batches`, medical)).body as B[];
    expect(all.find((b) => b.batchNo === 'AMX2499')).toMatchObject({ recalled: true, qtyUsable: 0 });
    const inStock = (await get(`/drugs/${amx}/batches?inStock=true`, medical)).body as B[];
    expect(inStock.map((b) => b.batchNo)).toEqual(['AMX2501']);
    const out = (await get(`/drugs/${await drugId('Paracetamol')}/batches?inStock=false`, medical)).body as B[];
    expect(out.map((b) => b.batchNo)).toEqual(['PCM2401']);
  });

  it('404 for an unknown drug; 403 without stock.view', async () => {
    expect((await get('/drugs/00000000-0000-4000-8000-000000000000/batches', medical)).status).toBe(404);
    expect((await get('/drugs/nope/batches', medical)).status).toBe(404);
    expect((await get(`/drugs/${await drugId('Paracetamol')}/batches`, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('GET /staff/partner-hospitals', () => {
  it('lists partner hospitals A to Z, with active', async () => {
    const { status, body } = await get('/partner-hospitals');
    expect(status).toBe(200);
    const list = body as { id: string; version: number; name: string }[];
    expect(list.map((h) => h.name)).toEqual(['AIIMS Bhopal', 'Bansal Hospital, Bhopal', 'Hamidia Hospital, Bhopal']);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['active', 'id', 'name', 'version']);
  });
});

describe('GET /staff/insurers', () => {
  it('lists insurers A to Z with code and active, inactive ones too', async () => {
    await db.query("UPDATE insurers SET active = false WHERE name = 'Care Health Insurance'");
    const { status, body } = await get('/insurers');
    expect(status).toBe(200);
    const list = body as { name: string; code?: string; active: boolean }[];
    expect(list).toHaveLength(4);
    expect(list.map((p) => p.name)).toEqual([...list.map((p) => p.name)].sort());
    expect(list.find((p) => p.name === 'Care Health Insurance')).toMatchObject({ code: expect.any(String), active: false });
  });
});

describe('GET /staff/tpas', () => {
  it('lists TPAs A to Z with code and active, inactive ones too', async () => {
    await db.query("UPDATE tpas SET active = false WHERE name = 'MD India Health Insurance TPA'");
    const { status, body } = await get('/tpas');
    expect(status).toBe(200);
    const list = body as { name: string; code?: string; active: boolean }[];
    expect(list).toHaveLength(4);
    expect(list.map((p) => p.name)).toEqual([...list.map((p) => p.name)].sort());
    expect(list.find((p) => p.name === 'MD India Health Insurance TPA')).toMatchObject({ code: expect.any(String), active: false });
  });
});

describe('GET /staff/codes/icd10', () => {
  const codes = async (query: string) => ((await get(`/codes/icd10${query}`)).body as { code: string; text: string }[]).map((c) => c.code);

  it('finds codes by code (dots ignored) first, then by text', async () => {
    expect(await codes('?q=e11')).toEqual(['E11.9']);
    expect(await codes('?q=E119')).toEqual(['E11.9']);
    expect(await codes('?q=j1')).toEqual(['J18.9']);
    expect(await codes('?q=unspecified')).toEqual(['A09', 'B54', 'J06.9', 'J18.9', 'K35.8']);
    expect((await get('/codes/icd10?q=I10')).body).toEqual([{ code: 'I10', text: 'Essential (primary) hypertension' }]);
  });

  it('limits the count; 422 without a 2-character q', async () => {
    expect(await codes('?q=unspecified&limit=2')).toHaveLength(2);
    for (const q of ['', '?q=e', '?q=e11&limit=99']) expect((await get(`/codes/icd10${q}`)).status).toBe(422);
  });

  it('does not mix in LOINC codes', async () => {
    expect(await codes('?q=heart')).toEqual([]);
  });
});

describe('GET /staff/codes/loinc', () => {
  it('finds the built-in vital signs by code or name, in a new database too', async () => {
    const empty = await openLocalDb();
    const res = await createApp({ db: async () => empty }).request('/staff/codes/loinc?q=blood%20pressure', {}, nurse);
    expect(await res.json()).toEqual([
      { code: '8462-4', text: 'Diastolic blood pressure' },
      { code: '8480-6', text: 'Systolic blood pressure' },
    ]);
    expect(((await get('/codes/loinc?q=8867')).body as { code: string }[]).map((c) => c.code)).toEqual(['8867-4']);
    expect((await get('/codes/loinc?q=x')).status).toBe(422);
  });
});
