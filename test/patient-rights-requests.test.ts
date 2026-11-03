import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #257 GET /patient/rights-requests, #258 POST /patient/rights-requests.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const A = asPatient('pt-rr-ramesh');
const B = asPatient('pt-rr-kavita');
const admin = ({ event: { requestContext: { authorizer: { jwt: { claims: { sub: 'dev-admin', 'cognito:groups': '[admin]' } } } } } }) as never;

const get = (q = '', who: never = A) => app.request(`/patient/rights-requests${q}`, {}, who);
const file = (body: unknown, who: never = A) =>
  app.request('/patient/rights-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const respond = (id: string, body: unknown) =>
  app.request(`/admin/rights-requests/${id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, admin);

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife (adult), portal access through A
const child = seedId('9a710000', 3); // A's ward, made a minor or adult per test
const kavita = seedId('9a710000', 4);
const AT = '2026-10-01T04:00:00Z';
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };
const KEYS = ['createdAt', 'dueBy', 'id', 'kind', 'outcome', 'outcomeReason', 'patientId', 'respondedAt', 'response', 'status', 'text'];
const STAFF = ['requestedBy', 'respondedBy', 'version', 'createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'uhid', 'patientName'];

type Item = Record<string, unknown> & { id: string };
const list = async (q = '', who: never = A) => (await (await get(q, who)).json()) as Item[];

async function request(patientId: string, createdAt: string, o: { voided?: boolean; status?: string } = {}) {
  const { rows } = await db.query(
    `INSERT INTO rights_requests (id, status, created_by, updated_by, created_at, updated_at, voided_at, patient_id, kind, text, requested_by)
     VALUES (gen_random_uuid(), $2, 'pt-sub', 'pt-sub', $1, $1, $3, $4, 'access', 'Please send my records', 'pt-sub') RETURNING id`,
    [createdAt, o.status ?? 'open', o.voided ? createdAt : null, patientId],
  );
  return String(rows[0]?.id);
}

let old: string, newer: string, voided: string, kavitaReq: string;

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-rr-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-rr-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $3, 'system', 'system', $4, $6, 'Ramesh', 'Husband', true), ($2, 'active', $3, 'system', 'system', $5, $6, 'Ramesh', 'Father', true)`,
    [randomUUID(), randomUUID(), AT, sita, child, ramesh],
  );
  old = await request(ramesh, '2026-01-01T00:00:00Z', { status: 'closed' });
  newer = await request(ramesh, '2026-02-01T00:00:00Z');
  voided = await request(ramesh, '2026-03-01T00:00:00Z', { voided: true });
  kavitaReq = await request(kavita, '2026-01-15T00:00:00Z');
});

describe('GET /patient/rights-requests', () => {
  it('own live requests newest first, dueBy 90 days on, no staff fields', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const items = (await res.json()) as Item[];
    expect(items.map((i) => i.id)).toEqual([newer, old]);
    expect(items.map((i) => i.id)).not.toContain(voided);
    expect(items[0]).toEqual({
      id: newer, patientId: ramesh, kind: 'access', text: 'Please send my records', status: 'open', createdAt: '2026-02-01T00:00:00.000Z',
      dueBy: '2026-05-02T00:00:00.000Z', response: null, outcome: null, outcomeReason: null, respondedAt: null,
    });
    for (const i of items) for (const k of STAFF) expect(i).not.toHaveProperty(k);
    expect(JSON.stringify(items)).not.toContain('pt-sub');
  });

  it("a family member's list; another patient's, unknown or bad ID is the generic 403", async () => {
    expect(await list(`?patientId=${sita}`)).toEqual([]);
    for (const other of [kavita, seedId('9a710000', 999), 'nope']) {
      const res = await get(`?patientId=${other}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await list('', B)).map((i) => i.id)).toEqual([kavitaReq]);
  });
});

describe('POST /patient/rights-requests', () => {
  it('files for self: 201, open, trimmed, requested_by is the sub, audited, newest first, in the admin list', async () => {
    const res = await file({ kind: 'correction', text: '  My date of birth is wrong on file  ' });
    expect(res.status).toBe(201);
    const r = (await res.json()) as Item;
    expect(Object.keys(r).sort()).toEqual(KEYS);
    expect(r).toMatchObject({ patientId: ramesh, kind: 'correction', text: 'My date of birth is wrong on file', status: 'open', response: null });
    const created = new Date(String(r.createdAt)).getTime();
    expect(Date.now() - created).toBeLessThan(60_000);
    expect(new Date(String(r.dueBy)).getTime() - created).toBe(90 * 86_400_000);

    const row = (await db.query('SELECT requested_by, created_by, status, version FROM rights_requests WHERE id = $1', [r.id])).rows[0];
    expect(row).toEqual({ requested_by: 'pt-rr-ramesh', created_by: 'pt-rr-ramesh', status: 'open', version: 1 });
    const audit = await db.query(
      "SELECT patient_id::text AS patient_id, action, role FROM audit_events WHERE record_type = 'rights_request' AND record_id = $1",
      [r.id],
    );
    expect(audit.rows).toEqual([{ patient_id: ramesh, action: 'create', role: 'patient' }]);

    expect((await list()).map((i) => i.id)).toEqual([r.id, newer, old]);
    const staff = (await (await app.request('/admin/rights-requests?status=open&limit=100', {}, admin)).json()) as { items: Item[] };
    expect(staff.items.find((i) => i.id === r.id)).toMatchObject({ patientId: ramesh, kind: 'correction', status: 'open' });
  });

  it('the officer responds (#333); the patient then sees the response and outcome', async () => {
    const r = (await (await file({ kind: 'access', text: 'Please send me a copy of my records' })).json()) as Item;
    const ok = await respond(r.id, { response: 'Some records are held back', outcome: 'partly_done', reason: 'Third-party data' });
    expect(ok.status).toBe(200);
    const seen = (await list()).find((i) => i.id === r.id);
    expect(seen).toMatchObject({ status: 'closed', response: 'Some records are held back', outcome: 'partly_done', outcomeReason: 'Third-party data' });
    expect(Date.now() - new Date(String(seen?.respondedAt)).getTime()).toBeLessThan(60_000);
    for (const k of STAFF) expect(seen).not.toHaveProperty(k);
    expect(JSON.stringify(seen)).not.toContain('dev-admin');
  });

  it('a parent files for a minor; not for an adult family member (403 adult_family_member)', async () => {
    const res = await file({ patientId: sita, kind: 'grievance', text: 'I was not given a privacy notice' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'adult_family_member' });

    await db.query('UPDATE patients SET dob = $2 WHERE id = $1', [child, '1990-01-01']);
    expect((await file({ patientId: child, kind: 'grievance', text: 'Wrong school name on file' })).status).toBe(403);
    await db.query('UPDATE patients SET dob = $2 WHERE id = $1', [child, `${new Date().getUTCFullYear() - 10}-06-15`]);
    const ok = await file({ patientId: child, kind: 'withdraw_consent', text: 'Please stop using his data for research' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ patientId: child, kind: 'withdraw_consent', status: 'open' });
    expect((await db.query('SELECT count(*)::int AS n FROM rights_requests WHERE patient_id = $1', [sita])).rows[0]!.n).toBe(0);
  });

  it("another patient's, unknown or bad patientId is the generic 403; nothing is filed", async () => {
    for (const other of [kavita, seedId('9a710000', 999), 'nope', 5]) {
      const res = await file({ patientId: other, kind: 'access', text: 'Please send my records' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await list('', B)).map((i) => i.id)).toEqual([kavitaReq]);
  });

  it('422 for a bad kind, short or long text, a missing field or an extra field', async () => {
    for (const body of [
      { kind: 'deletion', text: 'Please delete my data' },
      { kind: 'access', text: '   short   ' },
      { kind: 'access', text: 'x'.repeat(2001) },
      { kind: 'access' },
      { text: 'Please send my records' },
      { kind: 'access', text: 'Please send my records', status: 'closed' },
    ]) {
      expect((await file(body, B)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect((await list('', B)).map((i) => i.id)).toEqual([kavitaReq]);
  });

  it('409 too_many_open at 10 open requests; closed and voided ones do not count', async () => {
    // kavita has 1 open; add closed and voided ones, then fill up to 10 open.
    await request(kavita, '2026-01-16T00:00:00Z', { status: 'closed' });
    await request(kavita, '2026-01-17T00:00:00Z', { voided: true });
    for (let i = 0; i < 9; i++) expect((await file({ kind: 'grievance', text: `Complaint number ${i}` }, B)).status).toBe(201);
    const res = await file({ kind: 'grievance', text: 'Complaint number ten' }, B);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'too_many_open' });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM rights_requests WHERE patient_id = $1 AND status = 'open' AND voided_at IS NULL", [kavita]);
    expect(rows[0]!.n).toBe(10);
  });
});
