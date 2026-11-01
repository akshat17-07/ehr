import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { yearsBetween } from '../src/modules/patients/patients.js';
import { TIMELINE_SOURCES } from '../src/modules/patients/timeline.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const reception = asStaff('dev-reception', ['staff']);
type Summary = { uhid: string; name: string; ageYears?: number; inactive: boolean; mobile?: string };
const search = async (q: string, who = reception) => {
  const res = await app.request(`/staff/patients?q=${encodeURIComponent(q)}`, {}, who);
  return { status: res.status, body: (await res.json()) as { items: Summary[]; nextCursor?: string } };
};
const uhids = async (q: string) => (await search(q)).body.items.map((p) => p.uhid);
const patch = (id: string, body: unknown, who = reception) =>
  app.request(`/staff/patients/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const register = (body: unknown, who = reception) =>
  app.request('/staff/patients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('GET /staff/patients', () => {
  it('finds by UHID, by mobile (a family shares one) and by the start of the name', async () => {
    expect(await uhids('u24000001')).toEqual(['U24000001']);
    expect(await uhids('+91 98260-00001')).toEqual(['U24000001', 'U24000002']);
    expect(await uhids('ra')).toEqual(['U26000005', 'U24000001']);
    expect(await uhids('Kumar')).toEqual([]);
  });

  it('gives summary fields only, with age and the inactive flag', async () => {
    const [ramesh] = (await search('U24000001')).body.items;
    expect(Object.keys(ramesh ?? {}).sort()).toEqual(['ageYears', 'dob', 'id', 'inactive', 'mobile', 'name', 'sex', 'uhid', 'unknown']);
    expect(ramesh).toMatchObject({ ageYears: yearsBetween('1968-05-14', indiaDate()), inactive: false });
    expect((await search('U24000002')).body.items[0]?.inactive).toBe(true);
    expect((await search('U25000004')).body.items[0]?.inactive).toBe(true);
    // Age given at registration (45 on 2025-06-01) counts on.
    expect((await search('U25000003')).body.items[0]?.ageYears).toBe(45 + yearsBetween('2025-06-01', indiaDate()));
  });

  it('pages, and leaves out merged patients', async () => {
    const first = await app.request('/staff/patients?q=9826000001&limit=1', {}, reception);
    const body = (await first.json()) as { items: Summary[]; nextCursor: string };
    expect(body.items.map((p) => p.uhid)).toEqual(['U24000001']);
    const next = await app.request(`/staff/patients?q=9826000001&limit=1&cursor=${body.nextCursor}`, {}, reception);
    expect(((await next.json()) as { items: Summary[] }).items.map((p) => p.uhid)).toEqual(['U24000002']);

    await db.query("UPDATE patients SET merged_into = id WHERE uhid = 'U24000002'");
    expect(await uhids('9826000001')).toEqual(['U24000001']);
  });

  it('422 for a 1-letter name; 403 without patient.search', async () => {
    expect((await search('r')).status).toBe(422);
    expect((await search('ra', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/patients', () => {
  const year = indiaDate().slice(2, 4);
  const address = { line1: '4 Lalghati', city: 'Bhopal', district: 'Bhopal', state: 'Madhya Pradesh', pincode: '462030' };

  it('registers a patient with the next UHID of the year, active, with a guardian', async () => {
    const res = await register({ name: ' Meena Kushwaha ', sex: 'F', dob: '2019-03-04', mobile: '+91 7000011111', address,
      guardian: { name: 'Ramlal Kushwaha', relation: 'father', mobile: '7000011111' } });
    expect(res.status).toBe(201);
    const p = (await res.json()) as Record<string, unknown> & { id: string; uhid: string };
    expect(p.uhid).toMatch(new RegExp(`^U${year}\\d{6}$`));
    expect(p).toMatchObject({ name: 'Meena Kushwaha', sex: 'F', dob: '2019-03-04', mobile: '7000011111', address, unknown: false,
      inactive: false, labels: [], allergies: [], version: 1 });
    const guardians = await db.query('SELECT name, relation, mobile FROM guardians WHERE patient_id = $1', [p.id]);
    expect(guardians.rows).toEqual([{ name: 'Ramlal Kushwaha', relation: 'father', mobile: '7000011111' }]);
    expect(await uhids('meena')).toEqual([p.uhid]);
    const audit = await db.query("SELECT action, record_type FROM audit_events WHERE patient_id = $1", [p.id]);
    expect(audit.rows).toEqual([{ action: 'create', record_type: 'patient' }]);
  });

  it('gives the next numbers in turn and skips one already used', async () => {
    const a = (await (await register({ name: 'Test One', sex: 'M', ageYears: 30 })).json()) as { uhid: string; ageYears: number };
    expect(a.ageYears).toBe(30);
    await db.query(`UPDATE counters SET value = value - 1 WHERE name = 'uhid-${year}'`);
    const b = (await (await register({ name: 'Test Two', sex: 'O', ageYears: 1 })).json()) as { uhid: string };
    expect(Number(b.uhid.slice(3))).toBe(Number(a.uhid.slice(3)) + 1);
  });

  it('422 for bad input; 403 without patient.register', async () => {
    for (const body of [
      { name: 'No Age', sex: 'M' },
      { name: 'Both', sex: 'M', dob: '2000-01-01', ageYears: 26 },
      { name: 'Future', sex: 'M', dob: '2999-01-01' },
      { name: 'Bad Sex', sex: 'X', ageYears: 3 },
      { name: 'Bad Mobile', sex: 'F', ageYears: 3, mobile: '12345' },
      { name: 'Bad Pin', sex: 'F', ageYears: 3, address: { ...address, pincode: '46203' } },
      { name: 'Extra', sex: 'F', ageYears: 3, uhid: 'U26999999' },
    ]) expect((await register(body)).status, JSON.stringify(body)).toBe(422);
    expect((await register({ name: 'Nurse Try', sex: 'M', ageYears: 5 }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/patients/emergency', () => {
  const emergency = (body: unknown, who = reception) =>
    app.request('/staff/patients/emergency', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('registers an unknown patient as Unknown-<n> with a UHID, at once', async () => {
    const res = await emergency({ sex: 'M', approxAgeYears: 40, description: 'Road accident, blue shirt', broughtBy: '108 ambulance' });
    expect(res.status).toBe(201);
    const first = (await res.json()) as Record<string, unknown> & { uhid: string };
    expect(first).toMatchObject({ name: 'Unknown-1', sex: 'M', ageYears: 40, unknown: true, inactive: false,
      emergencyNote: 'Road accident, blue shirt', broughtBy: '108 ambulance' });
    expect(first.uhid).toMatch(/^U\d{8}$/);

    const doctor = asStaff('dev-doctor', ['doctor']);
    const second = (await (await emergency({ description: 'Found unconscious at bus stand' }, doctor)).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ name: 'Unknown-2', sex: 'O', unknown: true });
    expect(second.ageYears).toBeUndefined();
    expect(await uhids('unknown-')).toEqual([first.uhid, second.uhid]);
  });

  it('422 without a description; 403 without patient.register', async () => {
    expect((await emergency({ sex: 'F' })).status).toBe(422);
    expect((await emergency({ description: 'x' })).status).toBe(422);
    expect((await emergency({ description: 'Elderly woman' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/patients/{id}', () => {
  const ramesh = '9a710000-0000-4000-8000-000000000001';

  it('gives the whole patient, allergies included, and logs the view against the patient', async () => {
    const res = await app.request(`/staff/patients/${ramesh}`, {}, asStaff('dev-nurse', ['nurse']));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ramesh, uhid: 'U24000001', name: 'Ramesh Kumar Sharma', sex: 'M', dob: '1968-05-14',
      mobile: '9826000001', allergies: ['Penicillin'], labels: [], unknown: false, inactive: false, version: 1 });
    const audit = await db.query("SELECT action FROM audit_events WHERE patient_id = $1 AND user_id = 'dev-nurse'", [ramesh]);
    expect(audit.rows).toEqual([{ action: 'view' }]);
  });

  it('404 for no such patient; 403 without patient.view', async () => {
    for (const id of ['9a710000-0000-4000-8000-000000000999', 'not-a-uuid']) {
      expect((await app.request(`/staff/patients/${id}`, {}, reception)).status).toBe(404);
    }
    expect((await app.request(`/staff/patients/${ramesh}`, {}, asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('PATCH /staff/patients/{id}', () => {
  const kavita = '9a710000-0000-4000-8000-000000000004';

  it('edits details, keeps the old version, and switches between dob and age', async () => {
    const res = await patch(kavita, { version: 1, name: 'Kavita Patel Jain', mobile: '9000000044', email: 'kavita@example.in', reason: 'married' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, name: 'Kavita Patel Jain', mobile: '9000000044', email: 'kavita@example.in' });
    expect(await uhids('kavita patel j')).toEqual(['U25000004']);

    const aged = (await (await patch(kavita, { version: 2, ageYears: 31, email: null })).json()) as Record<string, unknown>;
    expect(aged).toMatchObject({ version: 3, ageYears: 31 });
    expect(aged.dob).toBeUndefined();
    expect(aged.email).toBeUndefined();
    const old = await db.query('SELECT version, reason FROM patients_versions WHERE record_id = $1 ORDER BY version', [kavita]);
    expect(old.rows).toEqual([{ version: 1, reason: 'married' }, { version: 2, reason: null }]);
  });

  it('409 for a stale version or a merged patient', async () => {
    expect((await patch(kavita, { version: 1, sex: 'F' })).status).toBe(409);
    const sita = '9a710000-0000-4000-8000-000000000002'; // merged in the search tests above
    expect((await patch(sita, { version: 1, sex: 'F' })).status).toBe(409);
  });

  it('marks an unknown patient identified, with their name', async () => {
    const unknown = (await (await register({ name: 'placeholder', sex: 'M', ageYears: 1 })).json()) as { id: string };
    await db.query("UPDATE patients SET unknown = true WHERE id = $1", [unknown.id]);
    expect((await patch(unknown.id, { version: 1, unknown: false })).status).toBe(422);
    const res = await patch(unknown.id, { version: 1, unknown: false, name: 'Suresh Ahirwar', ageYears: 52 });
    expect(await res.json()).toMatchObject({ unknown: false, name: 'Suresh Ahirwar', ageYears: 52 });
  });

  it('422 for bad input; 404 for no such patient; 403 without patient.update', async () => {
    for (const body of [{ name: 'No Version' }, { version: 3, unknown: true }, { version: 3, dob: '2000-01-01', ageYears: 3 }, { version: 3, uhid: 'U1' }]) {
      expect((await patch(kavita, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await app.request(`/staff/patients/${kavita}`, { method: 'PATCH', body: 'not json' }, reception)).status).toBe(422);
    expect((await patch('9a710000-0000-4000-8000-000000000999', { version: 1, sex: 'M' })).status).toBe(404);
    expect((await patch(kavita, { version: 3, sex: 'F' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/patients/{id}/versions', () => {
  it('lists every version with who, when and why, dates unchanged', async () => {
    const rahul = '9a710000-0000-4000-8000-000000000005';
    await patch(rahul, { version: 1, mobile: '8800000055', reason: 'new number' });
    const res = await app.request(`/staff/patients/${rahul}/versions`, {}, asStaff('dev-nurse', ['nurse']));
    expect(res.status).toBe(200);
    const versions = (await res.json()) as { version: number; by: string; reason?: string; data: { dob: string; mobile: string } }[];
    expect(versions.map((v) => [v.version, v.by, v.reason, v.data.mobile, v.data.dob])).toEqual([
      [1, 'system', undefined, '8800000005', '2016-08-09'],
      [2, 'dev-reception', 'new number', '8800000055', '2016-08-09'],
    ]);
  });

  it('404 for no such patient', async () => {
    for (const id of ['9a710000-0000-4000-8000-000000000999', 'x']) {
      expect((await app.request(`/staff/patients/${id}/versions`, {}, reception)).status).toBe(404);
    }
  });
});

describe('GET /staff/patients/{id}/timeline', () => {
  const ramesh = '9a710000-0000-4000-8000-000000000001';
  const timeline = async (query = '') => {
    const res = await app.request(`/staff/patients/${ramesh}/timeline${query}`, {}, asStaff('dev-doctor', ['doctor']));
    return { status: res.status, body: (await res.json()) as { items: { kind: string; title: string; at: string }[]; nextCursor?: string } };
  };

  it('is empty until a module adds its records', async () => {
    expect((await timeline()).body).toEqual({ items: [] });
  });

  it('merges every source newest first, with paging and date and kind filters', async () => {
    // Stand-ins for tables later modules add.
    for (const table of ['t_visits', 't_bills']) {
      await db.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY, patient_id uuid, at timestamptz, label text, voided_at timestamptz)`);
    }
    await db.query(`INSERT INTO t_visits VALUES
      ('00000000-0000-4000-8000-000000000001', '${ramesh}', '2026-03-01T04:00:00Z', 'Medicine', null),
      ('00000000-0000-4000-8000-000000000002', '${ramesh}', '2026-03-10T20:00:00Z', 'Surgery', null),
      ('00000000-0000-4000-8000-000000000003', '${ramesh}', '2026-03-05T04:00:00Z', 'Voided', now()),
      ('00000000-0000-4000-8000-000000000004', '9a710000-0000-4000-8000-000000000003', '2026-03-05T04:00:00Z', 'Other patient', null)`);
    await db.query(`INSERT INTO t_bills VALUES ('00000000-0000-4000-8000-000000000005', '${ramesh}', '2026-03-05T04:00:00Z', 'INV-1', null)`);
    TIMELINE_SOURCES.push(
      { kind: 'encounter', table: 't_visits', at: 'at', title: "'OPD: ' || label" },
      { kind: 'bill', table: 't_bills', at: 'at', title: "'Bill ' || label" },
    );
    try {
      expect((await timeline()).body.items.map((i) => i.title)).toEqual(['OPD: Surgery', 'Bill INV-1', 'OPD: Medicine']);
      const first = (await timeline('?limit=2')).body;
      expect(first.items).toHaveLength(2);
      expect((await timeline(`?limit=2&cursor=${first.nextCursor}`)).body.items.map((i) => i.title)).toEqual(['OPD: Medicine']);
      expect((await timeline('?kind=bill')).body.items.map((i) => i.title)).toEqual(['Bill INV-1']);
      // 2026-03-10T20:00Z is 11 March in India.
      expect((await timeline('?from=2026-03-05&to=2026-03-10')).body.items.map((i) => i.title)).toEqual(['Bill INV-1']);
      expect((await timeline('?from=2026-03-11')).body.items.map((i) => i.title)).toEqual(['OPD: Surgery']);
    } finally {
      TIMELINE_SOURCES.length = 0;
    }
  });

  it('422 for a bad kind; 404 for no such patient', async () => {
    expect((await timeline('?kind=lab')).status).toBe(422);
    expect((await app.request('/staff/patients/9a710000-0000-4000-8000-000000000999/timeline', {}, reception)).status).toBe(404);
  });
});

describe('POST /staff/patients/{id}/guardians', () => {
  const rahul = '9a710000-0000-4000-8000-000000000005';
  const ramesh = '9a710000-0000-4000-8000-000000000001';
  const add = (id: string, body: unknown) =>
    app.request(`/staff/patients/${id}/guardians`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, reception);

  it('adds a guardian, linked to a patient record if they are one, with portal access', async () => {
    const res = await add(rahul, { name: 'Ramesh Kumar Sharma', relation: 'grandfather', mobile: '9826000001', guardianPatientId: ramesh, portalAccess: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: rahul, guardianPatientId: ramesh, relation: 'grandfather', mobile: '9826000001',
      portalAccess: true, version: 1, status: 'active', createdBy: 'dev-reception' });
    expect(await (await add(rahul, { name: 'Anita Verma', relation: 'mother' })).json()).toMatchObject({ portalAccess: false });
    const audit = await db.query("SELECT record_type FROM audit_events WHERE patient_id = $1 AND action = 'create'", [rahul]);
    expect(audit.rows).toEqual([{ record_type: 'guardian' }, { record_type: 'guardian' }]);
  });

  it('422 for portal access without a mobile, a patient as their own guardian, or an unknown guardian patient', async () => {
    for (const body of [
      { name: 'No Mobile', relation: 'father', portalAccess: true },
      { name: 'Self', relation: 'self', guardianPatientId: rahul },
      { name: 'Ghost', relation: 'uncle', guardianPatientId: '9a710000-0000-4000-8000-000000000999' },
      { name: 'X', relation: 'uncle' },
    ]) expect((await add(rahul, body)).status, JSON.stringify(body)).toBe(422);
    expect((await add('9a710000-0000-4000-8000-000000000999', { name: 'Anita Verma', relation: 'mother' })).status).toBe(404);
  });
});

describe('POST /staff/patients/{id}/consents', () => {
  const ramesh = '9a710000-0000-4000-8000-000000000001';
  const consent = (body: unknown, id = ramesh) =>
    app.request(`/staff/patients/${id}/consents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, reception);

  it('records a consent given or refused, with the notice version and language', async () => {
    const res = await consent({ kind: 'privacy_notice', noticeVersion: '2026-01', language: 'hi', given: true });
    expect(res.status).toBe(201);
    const given = (await res.json()) as Record<string, unknown>;
    expect(given).toMatchObject({ patientId: ramesh, kind: 'privacy_notice', noticeVersion: '2026-01', language: 'hi', given: true, createdBy: 'dev-reception' });
    expect(Date.now() - Date.parse(String(given.givenAt))).toBeLessThan(60_000);
    expect(given.withdrawnAt).toBeUndefined();
    expect(await (await consent({ kind: 'research', language: 'en', given: false })).json()).toMatchObject({ kind: 'research', given: false });
  });

  it('422 without the notice version of a privacy notice, or for bad input; 404 for no such patient', async () => {
    for (const body of [
      { kind: 'privacy_notice', language: 'en', given: true },
      { kind: 'marketing', language: 'en', given: true },
      { kind: 'treatment', language: 'fr', given: true },
      { kind: 'treatment', language: 'en' },
    ]) expect((await consent(body)).status, JSON.stringify(body)).toBe(422);
    expect((await consent({ kind: 'treatment', language: 'en', given: true }, '9a710000-0000-4000-8000-000000000999')).status).toBe(404);
  });
});

describe('POST /staff/patient-merges', () => {
  const ramesh = '9a710000-0000-4000-8000-000000000001';
  const irfan = '9a710000-0000-4000-8000-000000000003';
  const sita = '9a710000-0000-4000-8000-000000000002'; // merged in the search tests above
  const head = asStaff('dev-head-doctor', ['head_doctor']);
  const propose = (body: unknown, who = head) =>
    app.request('/staff/patient-merges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('proposes a merge, pending until a second person approves', async () => {
    const res = await propose({ keepPatientId: ramesh, mergePatientId: irfan, reason: 'same person, registered twice' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ keepPatientId: ramesh, mergePatientId: irfan, status: 'pending', proposedBy: 'dev-head-doctor' });
    expect((await db.query('SELECT merged_into FROM patients WHERE id = $1', [irfan])).rows).toEqual([{ merged_into: null }]);
  });

  it('409 if a patient is already merged or in a pending merge; 422 for the same or an unknown patient; 403 for others', async () => {
    const rahul = '9a710000-0000-4000-8000-000000000005';
    expect((await propose({ keepPatientId: rahul, mergePatientId: irfan, reason: 'dup' })).status).toBe(409);
    expect((await propose({ keepPatientId: rahul, mergePatientId: sita, reason: 'dup' })).status).toBe(409);
    expect((await propose({ keepPatientId: rahul, mergePatientId: rahul, reason: 'dup' })).status).toBe(422);
    expect((await propose({ keepPatientId: rahul, mergePatientId: '9a710000-0000-4000-8000-000000000999', reason: 'dup' })).status).toBe(422);
    expect((await propose({ keepPatientId: rahul, mergePatientId: irfan })).status).toBe(422);
    expect((await propose({ keepPatientId: rahul, mergePatientId: irfan, reason: 'dup' }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('the inactive-patient rule and POST /staff/patients/{id}/break-glass', () => {
  const kavita = '9a710000-0000-4000-8000-000000000004'; // never visited, so inactive
  const doctor = asStaff('dev-doctor', ['doctor']);
  const nurse = asStaff('dev-nurse', ['nurse']);
  const timeline = async (who: never) => (await app.request(`/staff/patients/${kavita}/timeline`, {}, who)).status;
  const breakGlass = (body: unknown, who: never = doctor) =>
    app.request(`/staff/patients/${kavita}/break-glass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('keeps an inactive patient\'s record closed, except to Head Doctors and Admins; details stay open', async () => {
    const res = await app.request(`/staff/patients/${kavita}/timeline`, {}, doctor);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'inactive_patient' });
    expect(await timeline(asStaff('dev-head-doctor', ['head_doctor']))).toBe(200);
    expect(await timeline(asStaff('dev-admin', ['admin']))).toBe(200);
    expect((await app.request(`/staff/patients/${kavita}`, {}, doctor)).status).toBe(200);
  });

  it('opens it with an approved access request until it runs out', async () => {
    await db.query(
      `INSERT INTO access_requests (id, status, created_by, updated_by, patient_id, requested_by, reason, valid_until)
       VALUES (gen_random_uuid(), 'approved', 'dev-nurse', 'dev-nurse', $1, 'dev-nurse', 'review', now() + interval '1 hour')`,
      [kavita],
    );
    expect(await timeline(nurse)).toBe(200);
    await db.query("UPDATE access_requests SET valid_until = now() - interval '1 minute' WHERE requested_by = 'dev-nurse' AND patient_id = $1", [kavita]);
    expect(await timeline(nurse)).toBe(403);
  });

  it('break-glass opens it at once for an hour and alerts every Head Doctor and Admin', async () => {
    const res = await breakGlass({ reason: 'unconscious in casualty' });
    expect(res.status).toBe(201);
    const event = (await res.json()) as { userId: string; at: string; validUntil: string };
    expect(event).toMatchObject({ patientId: kavita, userId: 'dev-doctor', reason: 'unconscious in casualty' });
    expect(Date.parse(event.validUntil) - Date.parse(event.at)).toBe(3_600_000);
    expect(await timeline(doctor)).toBe(200);
    expect(await timeline(nurse)).toBe(403);

    const alerts = await db.query("SELECT user_id, title, body FROM alerts WHERE kind = 'breakglass' ORDER BY user_id");
    expect(alerts.rows).toEqual([
      { user_id: 'dev-admin', title: 'Break-glass: U25000004', body: 'Dr Neha Gupta used emergency access to U25000004: unconscious in casualty' },
      { user_id: 'dev-head-doctor', title: 'Break-glass: U25000004', body: 'Dr Neha Gupta used emergency access to U25000004: unconscious in casualty' },
    ]);

    await db.query("UPDATE break_glass_events SET valid_until = now() - interval '1 minute' WHERE user_id = 'dev-doctor'");
    expect(await timeline(doctor)).toBe(403);
  });

  it('422 without a reason; 404 for no such patient; 403 without breakglass.invoke', async () => {
    expect((await breakGlass({})).status).toBe(422);
    expect((await app.request('/staff/patients/9a710000-0000-4000-8000-000000000999/break-glass',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'emergency' }) }, doctor)).status).toBe(404);
    expect((await breakGlass({ reason: 'emergency' }, reception)).status).toBe(403);
  });
});
