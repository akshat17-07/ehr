import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const nurse = asStaff('dev-nurse', ['nurse']);
const ramesh = seedId('9a710000', 1);

describe('GET /staff/patients/{id}/dental-chart', () => {
  const chart = (patient: string, who = doctor) => app.request(`/staff/patients/${patient}/dental-chart`, {}, who);

  it("groups the patient's entries by tooth, oldest first", async () => {
    expect(await (await chart(ramesh)).json()).toEqual({ teeth: {} });
    for (const [tooth, condition, at] of [['36', 'Caries', '2026-01-10T05:00:00Z'], ['11', 'Fracture', '2026-02-01T05:00:00Z'], ['36', 'Filled', '2026-03-01T05:00:00Z']]) {
      await db.query(
        "INSERT INTO dental_entries (id, status, created_by, updated_by, patient_id, tooth, condition, at) VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $2, $3, $4)",
        [ramesh, tooth, condition, at],
      );
    }
    const body = (await (await chart(ramesh)).json()) as { teeth: Record<string, { condition: string }[]> };
    expect(Object.keys(body.teeth).sort()).toEqual(['11', '36']);
    expect(body.teeth['36']?.map((e) => e.condition)).toEqual(['Caries', 'Filled']);
  });

  it('404 for no patient; 403 for a nurse', async () => {
    expect((await chart(seedId('9a710000', 999))).status).toBe(404);
    expect((await chart(ramesh, nurse)).status).toBe(403);
  });
});

describe('POST /staff/patients/{id}/dental-chart', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const add = (patient: string, body: unknown, who = doctor) => app.request(`/staff/patients/${patient}/dental-chart`, json(body), who);
  const irfan = seedId('9a710000', 3);

  it('saves several teeth at once, in an encounter of the patient', async () => {
    const opened = await app.request('/staff/encounters', json({ patientId: irfan, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) }), doctor);
    const encounterId = ((await opened.json()) as { id: string }).id;
    const res = await add(irfan, { encounterId, entries: [{ tooth: '46', surface: 'mo', condition: 'Deep caries', treatment: 'Root canal advised' }, { tooth: '55', condition: 'Mobile milk tooth' }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject([
      { patientId: irfan, encounterId, tooth: '46', surface: 'MO', condition: 'Deep caries', treatment: 'Root canal advised' },
      { tooth: '55', condition: 'Mobile milk tooth' },
    ]);
    const chart = (await (await app.request(`/staff/patients/${irfan}/dental-chart`, {}, doctor)).json()) as { teeth: Record<string, unknown[]> };
    expect(Object.keys(chart.teeth).sort()).toEqual(['46', '55']);
    expect((await add(ramesh, { encounterId, entries: [{ tooth: '11', condition: 'Caries' }] })).status).toBe(422);
  });

  it('422 for a bad tooth, surface or no entries; 404 for no patient; 403 for a nurse', async () => {
    expect((await add(irfan, { entries: [{ tooth: '19', condition: 'Caries' }] })).status).toBe(422);
    expect((await add(irfan, { entries: [{ tooth: '56', condition: 'Caries' }] })).status).toBe(422);
    expect((await add(irfan, { entries: [{ tooth: '36', surface: 'X', condition: 'Caries' }] })).status).toBe(422);
    expect((await add(irfan, { entries: [] })).status).toBe(422);
    expect((await add(seedId('9a710000', 999), { entries: [{ tooth: '36', condition: 'Caries' }] })).status).toBe(404);
    expect((await add(irfan, { entries: [{ tooth: '36', condition: 'Caries' }] }, nurse)).status).toBe(403);
  });
});

describe('GET /staff/patients/{id}/anc-records', () => {
  const list = (patient: string, who = doctor) => app.request(`/staff/patients/${patient}/anc-records`, {}, who);

  it("lists the patient's ANC visits, oldest first", async () => {
    expect(await (await list(ramesh)).json()).toEqual([]);
    await db.query(
      `INSERT INTO anc_records (id, status, created_by, updated_by, patient_id, lmp, edd, gravida, para, gestation_weeks, bp, weight_kg, fhr)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, '2026-06-01', '2027-03-08', 2, 1, 22, '110/70', 58.5, 140)`,
      [ramesh],
    );
    expect(await (await list(ramesh)).json()).toMatchObject([
      { patientId: ramesh, lmp: '2026-06-01', edd: '2027-03-08', gravida: 2, para: 1, gestationWeeks: 22, bp: '110/70', weightKg: 58.5, fhr: 140 },
    ]);
  });

  it('404 for no patient; 403 for a nurse', async () => {
    expect((await list(seedId('9a710000', 999))).status).toBe(404);
    expect((await list(ramesh, nurse)).status).toBe(403);
  });
});

describe('POST /staff/patients/{id}/anc-records', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const add = (patient: string, body: unknown, who = doctor) => app.request(`/staff/patients/${patient}/anc-records`, json(body), who);
  const rahul = seedId('9a710000', 5);

  it('records a visit, which then shows in the list', async () => {
    const res = await add(rahul, { lmp: '2026-07-01', edd: '2027-04-07', gravida: 1, para: 0, gestationWeeks: 17, bp: '118/76', weightKg: 61.2, fundalHeightCm: 16, fhr: 148, notes: 'Doing well.' });
    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record).toMatchObject({ patientId: rahul, lmp: '2026-07-01', edd: '2027-04-07', gravida: 1, para: 0, gestationWeeks: 17, bp: '118/76', weightKg: 61.2, fundalHeightCm: 16, fhr: 148, version: 1 });
    expect(await (await app.request(`/staff/patients/${rahul}/anc-records`, {}, doctor)).json()).toMatchObject([{ id: (record as { id: string }).id }]);
  });

  it('422 for bad values, a future LMP, EDD before LMP, para >= gravida, another patient\'s encounter or nothing recorded', async () => {
    expect((await add(rahul, { bp: '120-80' })).status).toBe(422);
    expect((await add(rahul, { fhr: 20 })).status).toBe(422);
    expect((await add(rahul, { lmp: '2099-01-01' })).status).toBe(422);
    expect((await add(rahul, { lmp: '2026-07-01', edd: '2026-06-01' })).status).toBe(422);
    expect((await add(rahul, { gravida: 2, para: 2 })).status).toBe(422);
    expect((await add(rahul, {})).status).toBe(422);
    expect((await add(rahul, { encounterId: seedId('e0000000', 999), notes: 'x' })).status).toBe(422);
  });

  it('404 for no patient; 403 for a nurse', async () => {
    expect((await add(seedId('9a710000', 999), { notes: 'x' })).status).toBe(404);
    expect((await add(rahul, { notes: 'x' }, nurse)).status).toBe(403);
  });
});
