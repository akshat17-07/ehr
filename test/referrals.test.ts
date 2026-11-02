import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

/** A referrer row straight in the table (POST /staff/referrers comes at #142). */
async function insertReferrer(name: string, phone: string | null, regNo: string | null, mergedInto: string | null = null) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, town, phone, reg_no, merged_into, pseudo)
     VALUES ($1, 'active', 'test', 'test', $2, $3, 'Indore', $4, $5, $6, true)`,
    [id, name, name.toLowerCase(), phone, regNo, mergedInto],
  );
  return id;
}

describe('GET /staff/referrers', () => {
  it('finds by part of the name, the phone or the reg no., leaving out merged ones', async () => {
    const anil = await insertReferrer('Dr Anil Joshi', '9800000001', 'MP-12345');
    const anita = await insertReferrer('Dr Anita Rao', '9800000002', null);
    await insertReferrer('Dr Anil Joshi (old)', '9800000009', null, anil);
    const search = async (q: string) => ((await (await app.request(`/staff/referrers?q=${encodeURIComponent(q)}`, {}, doctor)).json()) as { id: string }[]).map((r) => r.id);
    expect(await search('ani')).toEqual([anil, anita]);
    expect(await search('9800000002')).toEqual([anita]);
    expect(await search('mp-12345')).toEqual([anil]);
    const [first] = (await (await app.request('/staff/referrers?q=anil', {}, doctor)).json()) as object[];
    expect(first).toMatchObject({ name: 'Dr Anil Joshi', town: 'Indore', phone: '9800000001', regNo: 'MP-12345', pseudo: true });
    expect(await search('100%')).toEqual([]);
  });

  it('422 for a too-short search; 403 without referrer.view', async () => {
    expect((await app.request('/staff/referrers?q=a', {}, doctor)).status).toBe(422);
    expect((await app.request('/staff/referrers?q=anil', {}, asStaff('dev-medical', ['medical']))).status).toBe(403);
  });
});

const post = (path: string, body: unknown, who = doctor) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('POST /staff/referrers', () => {
  it('adds a pseudo referrer; the same phone or reg no. is a possible duplicate until forced', async () => {
    const res = await post('/staff/referrers', { name: 'Dr Meera Shah', clinic: 'Shah Clinic', town: 'Dewas', phone: '9811111111', regNo: 'MP-777' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string };
    expect(made).toMatchObject({ name: 'Dr Meera Shah', clinic: 'Shah Clinic', town: 'Dewas', phone: '9811111111', regNo: 'MP-777', pseudo: true, createdBy: 'dev-doctor' });
    const again = await post('/staff/referrers', { name: 'Meera Shah', regNo: 'mp-777' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'possible_duplicate', matches: [{ id: made.id }] });
    expect((await post('/staff/referrers', { name: 'Meera Shah', regNo: 'mp-777', force: true })).status).toBe(201);
  });

  it('a new patient can name who sent them', async () => {
    const ref = (await (await post('/staff/referrers', { name: 'Dr Om Prakash' })).json()) as { id: string };
    const patient = { name: 'Geeta Bai', sex: 'F', ageYears: 50 };
    const res = await post('/staff/patients', { ...patient, referrerId: ref.id }, asStaff('dev-reception', ['staff']));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ referrerId: ref.id });
    expect((await post('/staff/patients', { ...patient, referrerId: randomUUID() }, asStaff('dev-reception', ['staff']))).status).toBe(422);
  });

  it('422 for a bad phone; 403 without referrer.create_pseudo', async () => {
    expect((await post('/staff/referrers', { name: 'Dr X', phone: '12345' })).status).toBe(422);
    expect((await post('/staff/referrers', { name: 'Dr X' }, asStaff('dev-medical', ['medical']))).status).toBe(403);
  });
});

describe('POST /staff/patients/{id}/referrals', () => {
  const ramesh = seedId('9a710000', 1);
  const refer = (patientId: string, body: unknown, who = doctor) => post(`/staff/patients/${patientId}/referrals`, body, who);

  it('records who sent the patient, from today unless dated', async () => {
    const referrerId = await insertReferrer('Dr Kiran Patel', null, null);
    const res = await refer(ramesh, { referrerId, reason: 'chest pain' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { date: string };
    expect(made).toMatchObject({ status: 'received', patientId: ramesh, referrerId, reason: 'chest pain', createdBy: 'dev-doctor' });
    expect(made.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await (await refer(ramesh, { referrerId, date: '2026-01-15' })).json()).toMatchObject({ date: '2026-01-15' });
  });

  it('422 for an unknown or merged referrer or a future date; 404 for no patient; 403 without referral.record', async () => {
    const live = await insertReferrer('Dr Live', null, null);
    const merged = await insertReferrer('Dr Merged', null, null, live);
    expect((await refer(ramesh, { referrerId: randomUUID() })).status).toBe(422);
    expect((await refer(ramesh, { referrerId: merged })).status).toBe(422);
    expect((await refer(ramesh, { referrerId: live, date: '2099-01-01' })).status).toBe(422);
    expect((await refer(seedId('9a710000', 999), { referrerId: live })).status).toBe(404);
    expect((await refer(ramesh, { referrerId: live }, asStaff('dev-medical', ['medical']))).status).toBe(403);
  });
});

describe('GET /staff/referrals', () => {
  it('pages referrals newest date first, filtered by referrer and dates', async () => {
    const referrerId = await insertReferrer('Dr Paging', null, null);
    const ids: string[] = [];
    for (const [patient, date] of [[1, '2026-02-01'], [3, '2026-02-03'], [4, '2026-02-02']] as const) {
      const res = await post(`/staff/patients/${seedId('9a710000', patient)}/referrals`, { referrerId, date });
      ids.push(((await res.json()) as { id: string }).id);
    }
    const list = async (q: string) => (await (await app.request(`/staff/referrals?referrerId=${referrerId}${q}`, {}, doctor)).json()) as { items: { id: string }[]; nextCursor?: string };
    const first = await list('&limit=2');
    expect(first.items.map((r) => r.id)).toEqual([ids[1], ids[2]]);
    expect((await list(`&limit=2&cursor=${first.nextCursor}`)).items.map((r) => r.id)).toEqual([ids[0]]);
    expect((await list('&from=2026-02-02&to=2026-02-02')).items.map((r) => r.id)).toEqual([ids[2]]);
  });

  it('422 for from after to; 403 without referrer.view', async () => {
    expect((await app.request('/staff/referrals?from=2026-03-02&to=2026-03-01', {}, doctor)).status).toBe(422);
    expect((await app.request('/staff/referrals', {}, asStaff('dev-medical', ['medical']))).status).toBe(403);
  });
});
