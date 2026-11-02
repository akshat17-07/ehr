import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

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
    expect(await (await get(id)).json()).toMatchObject({ id, procedure: 'Total knee replacement', implants: [], venuePayments: [] });
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

describe('PATCH /staff/surgeries/{id}', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const patch = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/surgeries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const partner = seedId('9a000000', 1);
  const planned = async (extra: object = {}) =>
    (await (await app.request('/staff/surgeries', json({ patientId: irfan, procedure: 'Laparoscopic cholecystectomy', surgeonId, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), venue: 'own', chargesPaise: 6000000, ...extra }), doctor)).json()) as { id: string; version: number };

  it('reschedules and moves the venue; the old row is in the history with the reason', async () => {
    const { id, version } = await planned();
    const at = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = await patch(id, { version, scheduledAt: at, venue: 'partner', partnerHospitalId: partner, chargesPaise: 6500000, reason: 'OT booked at the partner hospital' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: version + 1, scheduledAt: at, venue: 'partner', partnerHospitalId: partner, chargesPaise: 6500000 });
    const history = (await db.query('SELECT reason FROM surgeries_versions WHERE record_id = $1', [id])).rows;
    expect(history).toEqual([{ reason: 'OT booked at the partner hospital' }]);
    const back = (await (await patch(id, { version: version + 1, venue: 'own' })).json()) as Record<string, unknown>;
    expect(back.venue).toBe('own');
    expect(back.partnerHospitalId).toBeUndefined();
  });

  it('422 for a partner without its hospital, a hospital for our own theatre or nothing to change', async () => {
    const { id, version } = await planned();
    expect((await patch(id, { version, venue: 'partner' })).status).toBe(422);
    expect((await patch(id, { version, partnerHospitalId: partner })).status).toBe(422);
    expect((await patch(id, { version, reason: 'Just because' })).status).toBe(422);
  });

  it('409 once done or cancelled, or for a stale version; 403 for a nurse; 404 for none', async () => {
    const { id, version } = await planned();
    expect((await patch(id, { version, chargesPaise: 1 }, nurse)).status).toBe(403);
    expect((await patch(id, { version: version + 5, chargesPaise: 1 })).status).toBe(409);
    await db.query("UPDATE surgeries SET status = 'done' WHERE id = $1", [id]);
    expect(await (await patch(id, { version, chargesPaise: 1 })).json()).toMatchObject({ error: 'done' });
    await db.query("UPDATE surgeries SET status = 'cancelled' WHERE id = $1", [id]);
    expect(await (await patch(id, { version, chargesPaise: 1 })).json()).toMatchObject({ error: 'cancelled' });
    expect((await patch(seedId('5e000000', 999), { version: 1, chargesPaise: 1 })).status).toBe(404);
  });
});

describe('POST /staff/surgeries/{id}/checklist', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const record = (id: string, body: unknown, who = doctor) => app.request(`/staff/surgeries/${id}/checklist`, json(body), who);
  const yes = (items: readonly string[]) => Object.fromEntries(items.map((k) => [k, true]));
  const signIn = { ...yes(['identity', 'site', 'consent', 'siteMarked', 'anaesthesiaCheck', 'pulseOximeter', 'airwayRisk']), allergies: false, bloodLossRisk: false };
  const timeOut = yes(['teamIntroduced', 'patientSiteProcedureConfirmed', 'antibioticProphylaxis', 'criticalEventsReviewed', 'imagingDisplayed']);
  const signOut = yes(['procedureRecorded', 'countsCorrect', 'specimenLabelled', 'equipmentProblems', 'recoveryConcerns']);
  const planned = async () =>
    ((await (await app.request('/staff/surgeries', json({ patientId: irfan, procedure: 'Hernia repair', surgeonId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), venue: 'own', chargesPaise: 3000000 }), doctor)).json()) as { id: string }).id;

  it('records the phases in order, each with who and when', async () => {
    const id = await planned();
    const first = await record(id, { signIn });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ checklist: { signIn: { ...signIn, by: 'dev-doctor', at: expect.any(String) } }, version: 2 });
    const all = (await (await record(id, { timeOut, signOut })).json()) as { checklist: Record<string, unknown> };
    expect(Object.keys(all.checklist)).toEqual(['signIn', 'timeOut', 'signOut']);
  });

  it('422 out of order, for a missing or unknown item, or nothing; 409 when cancelled; 403 for a nurse', async () => {
    const id = await planned();
    expect((await record(id, { timeOut })).status).toBe(422);
    expect((await record(id, { signIn: { ...signIn, identity: undefined } })).status).toBe(422);
    expect((await record(id, { signIn: { ...signIn, extra: true } })).status).toBe(422);
    expect((await record(id, {})).status).toBe(422);
    expect((await record(id, { signIn }, nurse)).status).toBe(403);
    await db.query("UPDATE surgeries SET status = 'cancelled' WHERE id = $1", [id]);
    expect(await (await record(id, { signIn })).json()).toMatchObject({ error: 'cancelled' });
  });
});

describe('POST /staff/surgeries/{id}/op-note', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const write = (id: string, body: unknown, who = doctor) => app.request(`/staff/surgeries/${id}/op-note`, json(body), who);
  const note = { findings: 'Inflamed appendix, no perforation.', procedureDone: 'Laparoscopic appendicectomy.', bloodLossMl: 50 };
  const planned = async () =>
    ((await (await app.request('/staff/surgeries', json({ patientId: irfan, procedure: 'Appendicectomy', surgeonId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), venue: 'own', chargesPaise: 3000000 }), doctor)).json()) as { id: string; version: number });

  it('writes the note and marks the surgery done; then it cannot change', async () => {
    const { id, version } = await planned();
    const res = await write(id, note);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'done', opNote: { ...note, by: 'dev-doctor', at: expect.any(String) }, version: version + 1 });
    expect(await (await write(id, note)).json()).toMatchObject({ error: 'done' });
    const patch = await app.request(`/staff/surgeries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: version + 1, chargesPaise: 1 }) }, doctor);
    expect(await patch.json()).toMatchObject({ error: 'done' });
  });

  it('implants used: 422 until one is recorded', async () => {
    const { id } = await planned();
    expect((await write(id, { ...note, implantsUsed: true })).status).toBe(422);
    await app.request(`/staff/surgeries/${id}/implants`, json({ name: 'Mesh', batchNo: 'M-1', mrpPaise: 500000 }), doctor);
    expect((await write(id, { ...note, implantsUsed: true })).status).toBe(200);
  });

  it('422 without findings; 403 for a nurse; 404 for none', async () => {
    const { id } = await planned();
    expect((await write(id, { procedureDone: 'x' })).status).toBe(422);
    expect((await write(id, note, nurse)).status).toBe(403);
    expect((await write(seedId('5e000000', 999), note)).status).toBe(404);
  });
});

describe('POST /staff/surgeries/{id}/venue-payments', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pay = (id: string, body: unknown, who = doctor) => app.request(`/staff/surgeries/${id}/venue-payments`, json(body), who);
  const partner = seedId('9a000000', 2);
  const payment = { amountPaise: 2000000, paidOn: '2026-10-30', mode: 'bank', reference: 'NEFT 4471' };
  const planned = async (venue: object) =>
    ((await (await app.request('/staff/surgeries', json({ patientId: irfan, procedure: 'Spine fixation', surgeonId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), chargesPaise: 9000000, ...venue }), doctor)).json()) as { id: string }).id;

  it("pays the surgery's partner hospital; the payment shows on the surgery", async () => {
    const id = await planned({ venue: 'partner', partnerHospitalId: partner });
    const res = await pay(id, payment);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ surgeryId: id, partnerHospitalId: partner, ...payment, version: 1 });
    expect(await (await app.request(`/staff/surgeries/${id}`, {}, doctor)).json()).toMatchObject({ venuePayments: [{ amountPaise: 2000000, paidOn: '2026-10-30' }] });
  });

  it('422 for our own theatre, a future date or a bad mode; 403 for a nurse; 404 for none', async () => {
    const own = await planned({ venue: 'own' });
    expect((await pay(own, payment)).status).toBe(422);
    const id = await planned({ venue: 'partner', partnerHospitalId: partner });
    expect((await pay(id, { ...payment, paidOn: '2099-01-01' })).status).toBe(422);
    expect((await pay(id, { ...payment, mode: 'cheque' })).status).toBe(422);
    expect((await pay(id, payment, nurse)).status).toBe(403);
    expect((await pay(seedId('5e000000', 999), payment)).status).toBe(404);
  });
});

describe('POST /staff/surgeries/{id}/cancel', () => {
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cancel = (id: string, body: unknown, who = doctor) => app.request(`/staff/surgeries/${id}/cancel`, json(body), who);
  const planned = async () =>
    ((await (await app.request('/staff/surgeries', json({ patientId: ramesh, procedure: 'Cataract surgery', side: 'right', surgeonId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), venue: 'own', chargesPaise: 2000000 }), doctor)).json()) as { id: string; scheduledAt: string });

  it('cancels with the reason; still listed, as cancelled; off the timeline', async () => {
    const { id, scheduledAt } = await planned();
    const res = await cancel(id, { reason: 'Blood sugar too high today' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', voidReason: 'Blood sugar too high today', voidedBy: 'dev-doctor' });
    const day = indiaDate(new Date(scheduledAt));
    const list = (await (await app.request(`/staff/surgeries?from=${day}&to=${day}&status=cancelled`, {}, doctor)).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toContain(id);
    const timeline = (await (await app.request(`/staff/patients/${ramesh}/timeline`, {}, doctor)).json()) as { items: { id: string }[] };
    expect(timeline.items.map((i) => i.id)).not.toContain(id);
    expect(await (await cancel(id, { reason: 'Again, by mistake' })).json()).toMatchObject({ error: 'cancelled' });
  });

  it('409 once done; 422 without a reason; 403 for a nurse; 404 for none', async () => {
    const { id } = await planned();
    expect((await cancel(id, {})).status).toBe(422);
    expect((await cancel(id, { reason: 'Patient unwell' }, nurse)).status).toBe(403);
    await app.request(`/staff/surgeries/${id}/op-note`, json({ findings: 'Mature cataract.', procedureDone: 'Phaco with IOL.' }), doctor);
    expect(await (await cancel(id, { reason: 'Patient unwell' })).json()).toMatchObject({ error: 'done' });
    expect((await cancel(seedId('5e000000', 999), { reason: 'Patient unwell' })).status).toBe(404);
  });
});
