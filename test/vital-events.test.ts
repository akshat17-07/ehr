import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { migrations } from '../src/db/migrations.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
// Everyone counts as recently active, so the inactive-patient rule does not apply.
await db.query('UPDATE patients SET last_activity_at = now()');
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const nurse = asStaff('dev-nurse', ['nurse']);
const reception = asStaff('dev-reception', ['staff']);
const admin = asStaff('dev-admin', ['admin']);
const kavita = seedId('9a710000', 4); // F
const ramesh = seedId('9a710000', 1); // M
const sita = seedId('9a710000', 2);
const drId = seedId('a0000000', 3);
const nurseId = seedId('a0000000', 5);
const receptionId = seedId('a0000000', 6);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const send = (method: string, path: string, body?: unknown, who = doctor) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }, who);
const birth = (o: Record<string, unknown> = {}) => ({
  motherPatientId: kavita, bornAt: hoursAgo(5), sex: 'F', outcome: 'live', delivery: 'normal', deliveredBy: drId, ...o,
});
const death = (o: Record<string, unknown> = {}) => ({
  patientId: ramesh, diedAt: hoursAgo(3), immediateCause: 'Cardiac arrest', manner: 'natural', mlc: false, certifiedBy: drId, ...o,
});
const auditRows = async (recordType: string) => (await db.query('SELECT * FROM audit_events WHERE record_type = $1', [recordType])).rows;

describe('POST /staff/births', () => {
  it('201 with the birth; a nurse can be the one who delivered', async () => {
    const res = await send('POST', '/staff/births', birth({ weightGrams: 2900, gestationWeeks: 38, deliveredBy: nurseId, note: 'Healthy' }));
    expect(res.status).toBe(201);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      motherPatientId: kavita, sex: 'F', weightGrams: 2900, outcome: 'live', delivery: 'normal', birthOrder: 1, gestationWeeks: 38,
      deliveredBy: nurseId, status: 'active', version: 1, createdBy: 'dev-doctor',
    });
    expect(b).not.toHaveProperty('reportedAt');
    const rows = await auditRows('birth');
    expect(rows.find((r) => r.record_id === b.id)).toMatchObject({ patient_id: kavita, action: 'create' });
    expect(await (await send('GET', `/staff/births/${b.id}`)).json()).toMatchObject({ id: b.id });
  });

  it('422 for a future time, an old time, a male mother, a bad deliverer, bad numbers, unknown fields', async () => {
    const bad = async (o: Record<string, unknown>) => expect((await send('POST', '/staff/births', birth(o))).status, JSON.stringify(o)).toBe(422);
    await bad({ bornAt: new Date(Date.now() + 3_600_000).toISOString() });
    await bad({ bornAt: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    await bad({ bornAt: 'yesterday' });
    await bad({ motherPatientId: ramesh });
    await bad({ motherPatientId: randomUUID() });
    await bad({ deliveredBy: receptionId });
    await bad({ deliveredBy: randomUUID() });
    await bad({ weightGrams: 100 });
    await bad({ weightGrams: 9000 });
    await bad({ gestationWeeks: 10 });
    await bad({ birthOrder: 9 });
    await bad({ sex: 'X' });
    await bad({ extra: 1 });
    await bad({ note: 'x'.repeat(501) });
    await bad({ babyPatientId: randomUUID() });
  });

  it('403 for reception, 401 with no login', async () => {
    expect((await send('POST', '/staff/births', birth(), reception)).status).toBe(403);
    expect((await app.request('/staff/births', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('POST /staff/deaths', () => {
  it('201 with the death; a second live death is 409; a voided one can be recorded again', async () => {
    const res = await send('POST', '/staff/deaths', death({ antecedentCauses: ['Myocardial infarction'], icd10: ['I21.9', 'I46'], otherConditions: 'Diabetes' }));
    expect(res.status).toBe(201);
    const d = (await res.json()) as { id: string; version: number };
    expect(d).toMatchObject({
      patientId: ramesh, immediateCause: 'Cardiac arrest', antecedentCauses: ['Myocardial infarction'], icd10: ['I21.9', 'I46'],
      manner: 'natural', mlc: false, certifiedBy: drId, otherConditions: 'Diabetes',
    });
    expect((await auditRows('death')).find((r) => r.record_id === d.id)).toMatchObject({ patient_id: ramesh });
    const again = await send('POST', '/staff/deaths', death());
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_recorded' });
    expect((await send('POST', `/staff/deaths/${d.id}/void`, { reason: 'Recorded on wrong patient' })).status).toBe(200);
    expect((await send('POST', '/staff/deaths', death())).status).toBe(201);
  });

  it('422: future time, nurse or reception certifier, bad ICD-10, too many causes, bad manner; nurse may record but not certify', async () => {
    const bad = async (o: Record<string, unknown>, who = doctor) =>
      expect((await send('POST', '/staff/deaths', death({ patientId: sita, ...o }), who)).status, JSON.stringify(o)).toBe(422);
    await bad({ diedAt: new Date(Date.now() + 3_600_000).toISOString() });
    await bad({ diedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    await bad({ certifiedBy: nurseId });
    await bad({ certifiedBy: nurseId }, nurse);
    await bad({ certifiedBy: receptionId });
    await bad({ icd10: ['i21'] });
    await bad({ icd10: ['I21.999'] });
    await bad({ icd10: ['I10', 'I11', 'I12', 'I13', 'I15', 'I20'] });
    await bad({ antecedentCauses: ['One cause', 'Two cause', 'Three cause', 'Four cause'] });
    await bad({ antecedentCauses: ['ab'] });
    await bad({ manner: 'unknown' });
    await bad({ mlc: 'no' });
    await bad({ immediateCause: 'ab' });
    await bad({ patientId: randomUUID() });
    await bad({ encounterId: randomUUID() });
    await bad({ extra: true });
    // A nurse can write the record when a doctor certifies it.
    expect((await send('POST', '/staff/deaths', death({ patientId: sita }), nurse)).status).toBe(201);
  });

  it('403 for reception, 401 with no login', async () => {
    expect((await send('POST', '/staff/deaths', death({ patientId: kavita }), reception)).status).toBe(403);
    expect((await app.request('/staff/deaths', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('PATCH and void', () => {
  it('a birth: edit with a version, history row, 409 on a stale version, 422 empty, reported fields', async () => {
    const b = (await (await send('POST', '/staff/births', birth())).json()) as { id: string };
    const res = await send('PATCH', `/staff/births/${b.id}`, { version: 1, reason: 'Weight corrected', weightGrams: 3100, registrarRef: 'MP/2026/123', reportedAt: hoursAgo(1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ weightGrams: 3100, registrarRef: 'MP/2026/123', version: 2 });
    const hist = (await db.query('SELECT * FROM births_versions WHERE record_id = $1', [b.id])).rows;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ version: 1, reason: 'Weight corrected', replaced_by: 'dev-doctor' });
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 1, reason: 'Stale edit here', sex: 'M' })).status).toBe(409);
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 2, reason: 'Nothing changes' })).status).toBe(422);
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 2, reason: 'ok', weightGrams: 3000 })).status).toBe(422);
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 2, reason: 'Clear weight', weightGrams: null })).status).toBe(200);
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 3, reason: 'Reception cannot', note: 'x' }, reception)).status).toBe(403);
  });

  it('a death: edit, history row, certifier still must be a doctor', async () => {
    const d = (await (await send('POST', '/staff/deaths', death({ patientId: kavita }))).json()) as { id: string };
    const res = await send('PATCH', `/staff/deaths/${d.id}`, { version: 1, reason: 'Cause refined', immediateCause: 'Septic shock', icd10: ['A41.9'], mlc: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ immediateCause: 'Septic shock', icd10: ['A41.9'], mlc: true, version: 2 });
    expect((await db.query('SELECT 1 FROM deaths_versions WHERE record_id = $1', [d.id])).rows).toHaveLength(1);
    expect((await send('PATCH', `/staff/deaths/${d.id}`, { version: 1, reason: 'Stale edit here', mlc: false })).status).toBe(409);
    expect((await send('PATCH', `/staff/deaths/${d.id}`, { version: 2, reason: 'Nurse certifies', certifiedBy: nurseId })).status).toBe(422);
  });

  it('void keeps the row, needs a reason, cannot be repeated, and blocks later edits; 404 for unknown ids', async () => {
    const b = (await (await send('POST', '/staff/births', birth())).json()) as { id: string };
    expect((await send('POST', `/staff/births/${b.id}/void`, { reason: 'no' })).status).toBe(422);
    const res = await send('POST', `/staff/births/${b.id}/void`, { reason: 'Entered twice by mistake' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ voidReason: 'Entered twice by mistake', voidedBy: 'dev-doctor' });
    expect((await send('POST', `/staff/births/${b.id}/void`, { reason: 'Entered twice by mistake' })).status).toBe(409);
    expect((await send('PATCH', `/staff/births/${b.id}`, { version: 2, reason: 'Edit after void', note: 'x' })).status).toBe(409);
    expect((await db.query('SELECT 1 FROM births WHERE id = $1', [b.id])).rows).toHaveLength(1);
    expect((await send('GET', `/staff/births/${randomUUID()}`)).status).toBe(404);
    expect((await send('GET', '/staff/deaths/nope')).status).toBe(404);
    expect((await send('POST', `/staff/deaths/${randomUUID()}/void`, { reason: 'Does not exist' })).status).toBe(404);
  });

  it('GET: recorders and the compliance officer; reception cannot', async () => {
    const b = (await (await send('POST', '/staff/births', birth())).json()) as { id: string };
    expect((await send('GET', `/staff/births/${b.id}`, undefined, nurse)).status).toBe(200);
    expect((await send('GET', `/staff/births/${b.id}`, undefined, reception)).status).toBe(403);
  });
});

describe('patient rules', () => {
  it('403 for a restricted (MTP-labelled) patient on every route, for births (mother) and deaths', async () => {
    const mtp = seedId('9a710000', 5);
    // Rahul is a patient the test can label; the doctor has no mtp.view.
    await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [mtp]);
    const b = (await (await send('POST', '/staff/births', birth({ motherPatientId: kavita }))).json()) as { id: string };
    const d = (await (await send('POST', '/staff/deaths', death({ patientId: seedId('9a710000', 3) }))).json()) as { id: string };
    await db.query("UPDATE patients SET labels = '[\"mtp\"]' WHERE id IN ($1, $2)", [kavita, seedId('9a710000', 3)]);
    for (const [method, path, body] of [
      ['GET', `/staff/births/${b.id}`], ['PATCH', `/staff/births/${b.id}`, { version: 1, reason: 'Weight fixed', note: 'x' }],
      ['POST', `/staff/births/${b.id}/void`, { reason: 'Entered by mistake' }], ['POST', '/staff/births', birth({ motherPatientId: kavita })],
      ['GET', `/staff/deaths/${d.id}`], ['PATCH', `/staff/deaths/${d.id}`, { version: 1, reason: 'Cause fixed', mlc: true }],
      ['POST', `/staff/deaths/${d.id}/void`, { reason: 'Entered by mistake' }], ['POST', '/staff/deaths', death({ patientId: seedId('9a710000', 3) })],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'sensitive_record' });
    }
    // Nothing changed.
    expect((await db.query('SELECT version FROM births WHERE id = $1', [b.id])).rows[0]!.version).toBe(1);
    await db.query("UPDATE patients SET labels = '[]' WHERE id IN ($1, $2)", [kavita, seedId('9a710000', 3)]);
  });
});

describe('migration 0102 on a database made before it', () => {
  it('adds vital_events.record to doctor, head doctor and nurse only, once', async () => {
    const old = await openLocalDb();
    await seedDev(old);
    await old.query(`UPDATE type_permissions SET permissions = replace(permissions, ',"vital_events.record"', '') WHERE type IN ('doctor', 'nurse', 'head_doctor', 'staff')`);
    await old.query(`UPDATE type_permissions SET permissions = replace(permissions, '"vital_events.record",', '') WHERE type IN ('doctor', 'nurse', 'head_doctor', 'staff')`);
    const has = async (type: string) => String((await old.query('SELECT permissions FROM type_permissions WHERE type = $1', [type])).rows[0]!.permissions).includes('vital_events.record');
    expect(await has('doctor')).toBe(false);
    const update = migrations.find((m) => m.id === '0102_vital_events')!.statements({ apiRoleArn: 'x' }).find((q) => q.startsWith('UPDATE type_permissions'))!;
    await old.query(update);
    await old.query(update);
    for (const type of ['doctor', 'head_doctor', 'nurse']) expect(await has(type), type).toBe(true);
    expect(await has('staff')).toBe(false);
    expect(String((await old.query("SELECT permissions FROM type_permissions WHERE type = 'doctor'")).rows[0]!.permissions).match(/vital_events\.record/g)).toHaveLength(1);
  });
});
