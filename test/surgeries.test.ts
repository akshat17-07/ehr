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
const irfan = seedId('9a710000', 3);
const surgeonId = seedId('a0000000', 4);

describe('GET /staff/surgeries', () => {
  const list = (query: string, who = doctor) => app.request(`/staff/surgeries?${query}`, {}, who);
  const plan = (patientId: string, at: string, surgeon: string, status = 'scheduled') =>
    db.query(
      `INSERT INTO surgeries (id, status, created_by, updated_by, patient_id, procedure, surgeon_id, team_ids, scheduled_at, venue, charges_paise, consent_document_ids)
       VALUES (gen_random_uuid(), $4, 'x', 'x', $1, 'Appendicectomy', $2, '[]', $3, 'own', 2500000, '[]')`,
      [patientId, surgeon, at, status],
    );

  it("lists the days' surgeries earliest first, with the patient; filters by surgeon and status", async () => {
    await plan(irfan, '2026-11-10T09:00:00+05:30', surgeonId);
    await plan(ramesh, '2026-11-10T07:30:00+05:30', surgeonId);
    await plan(ramesh, '2026-11-11T23:30:00+05:30', seedId('a0000000', 3), 'cancelled');
    await plan(irfan, '2026-11-12T00:30:00+05:30', surgeonId);
    const day = (await (await list('from=2026-11-10&to=2026-11-11')).json()) as { patientId: string; chargesPaise: number; teamIds: string[]; patient: { id: string } }[];
    expect(day.map((s) => s.patientId)).toEqual([ramesh, irfan, ramesh]);
    expect(day[0]).toMatchObject({ procedure: 'Appendicectomy', chargesPaise: 2500000, teamIds: [], venue: 'own', status: 'scheduled', patient: { id: ramesh } });
    expect(await (await list(`from=2026-11-10&to=2026-11-12&surgeonId=${surgeonId}`)).json()).toHaveLength(3);
    expect(await (await list('from=2026-11-10&to=2026-11-12&status=cancelled')).json()).toHaveLength(1);
  });

  it('422 without dates, for to before from or over 92 days; 403 for a nurse', async () => {
    expect((await list('from=2026-11-10')).status).toBe(422);
    expect((await list('from=2026-11-10&to=2026-11-09')).status).toBe(422);
    expect((await list('from=2026-01-01&to=2026-06-30')).status).toBe(422);
    expect((await list('from=2026-11-10&to=2026-11-10', nurse)).status).toBe(403);
  });
});

describe('POST /staff/surgeries', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const plan = (body: unknown, who = doctor) => app.request('/staff/surgeries', json(body), who);
  const nurseId = seedId('a0000000', 5);
  const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  const surgery = { patientId: irfan, procedure: 'Open reduction, internal fixation', site: 'Femur', side: 'left', surgeonId, scheduledAt: inDays(3), venue: 'own', chargesPaise: 4500000 };

  it('plans the surgery; the surgeon is not repeated in the team; it shows on the timeline', async () => {
    const res = await plan({ ...surgery, teamIds: [nurseId, surgeonId, nurseId], instructions: 'Nil by mouth from midnight.' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toMatchObject({ status: 'scheduled', patientId: irfan, side: 'left', surgeonId, teamIds: [nurseId], venue: 'own', chargesPaise: 4500000, consentDocumentIds: [], version: 1 });
    const timeline = (await (await app.request(`/staff/patients/${irfan}/timeline`, {}, doctor)).json()) as { items: { kind: string; id: string; title: string }[] };
    expect(timeline.items).toContainEqual(expect.objectContaining({ kind: 'surgery', id: body.id, title: 'Surgery: Open reduction, internal fixation' }));
  });

  it('a partner venue needs its hospital, and only then', async () => {
    const partner = seedId('9a000000', 1);
    expect(await (await plan({ ...surgery, venue: 'partner', partnerHospitalId: partner })).json()).toMatchObject({ venue: 'partner', partnerHospitalId: partner });
    expect((await plan({ ...surgery, venue: 'partner' })).status).toBe(422);
    expect((await plan({ ...surgery, partnerHospitalId: partner })).status).toBe(422);
    expect((await plan({ ...surgery, venue: 'partner', partnerHospitalId: seedId('9a000000', 999) })).status).toBe(422);
  });

  it('422 for a non-doctor surgeon, an unknown team member or a date out of range; 404 for no patient; 403 for a nurse', async () => {
    expect((await plan({ ...surgery, surgeonId: nurseId })).status).toBe(422);
    expect((await plan({ ...surgery, teamIds: [seedId('a0000000', 999)] })).status).toBe(422);
    expect((await plan({ ...surgery, scheduledAt: inDays(-3) })).status).toBe(422);
    expect((await plan({ ...surgery, scheduledAt: inDays(400) })).status).toBe(422);
    expect((await plan({ ...surgery, side: 'up' })).status).toBe(422);
    expect((await plan({ ...surgery, patientId: seedId('9a710000', 999) })).status).toBe(404);
    expect((await plan(surgery, nurse)).status).toBe(403);
  });
});

describe('POST /staff/surgeries/{id}/implants', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const add = (id: string, body: unknown, who = doctor) => app.request(`/staff/surgeries/${id}/implants`, json(body), who);
  const implant = { name: 'Locking compression plate, 8 hole', manufacturer: 'Orthomed', batchNo: 'LCP-2611-044', size: '4.5 mm', mrpPaise: 1850000 };
  const surgeryOf = async (status = 'scheduled') =>
    String((await db.query(
      `INSERT INTO surgeries (id, status, created_by, updated_by, patient_id, procedure, surgeon_id, team_ids, scheduled_at, venue, charges_paise, consent_document_ids)
       VALUES (gen_random_uuid(), $1, 'x', 'x', $2, 'ORIF femur', $3, '[]', now(), 'own', 4500000, '[]') RETURNING id`,
      [status, irfan, surgeonId],
    )).rows[0]?.id);

  it("records the implant against the surgery's patient", async () => {
    const id = await surgeryOf();
    const res = await add(id, implant);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ surgeryId: id, patientId: irfan, ...implant, version: 1 });
  });

  it('409 for a cancelled surgery; 422 without a batch; 404 for none; 403 for a nurse', async () => {
    expect(await (await add(await surgeryOf('cancelled'), implant)).json()).toMatchObject({ error: 'cancelled' });
    const id = await surgeryOf();
    expect((await add(id, { ...implant, batchNo: undefined })).status).toBe(422);
    expect((await add(seedId('5e000000', 999), implant)).status).toBe(404);
    expect((await add(id, implant, nurse)).status).toBe(403);
  });
});

describe('GET /staff/surgeries/{id}', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (id: string, who = doctor) => app.request(`/staff/surgeries/${id}`, {}, who);

  it('returns the surgery with its implants', async () => {
    const planned = await app.request('/staff/surgeries', json({ patientId: irfan, procedure: 'Total knee replacement', side: 'right', surgeonId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), venue: 'own', chargesPaise: 15000000 }), doctor);
    const { id } = (await planned.json()) as { id: string };
    expect(await (await get(id)).json()).toMatchObject({ id, procedure: 'Total knee replacement', implants: [] });
    await app.request(`/staff/surgeries/${id}/implants`, json({ name: 'Knee prosthesis', batchNo: 'TK-77', mrpPaise: 9000000 }), doctor);
    expect(await (await get(id)).json()).toMatchObject({ implants: [{ name: 'Knee prosthesis', batchNo: 'TK-77', surgeryId: id }] });
  });

  it('404 for none; 403 for a nurse', async () => {
    expect((await get(seedId('5e000000', 999))).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
    const { id } = (await db.query('SELECT id FROM surgeries LIMIT 1')).rows[0] as { id: string };
    expect((await get(id, nurse)).status).toBe(403);
  });
});
