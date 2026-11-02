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
