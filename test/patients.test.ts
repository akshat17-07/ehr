import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { yearsBetween } from '../src/modules/patients/patients.js';
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
