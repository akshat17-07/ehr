import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #255 GET /patient/consents, #256 POST /patient/consents/{id}/withdraw.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const A = asPatient('pt-con-ramesh');
const B = asPatient('pt-con-kavita');
const get = (path: string, who: never = A) => app.request(path, {}, who);
const withdraw = (id: string, body: unknown = {}, who: never = A) =>
  app.request(`/patient/consents/${id}/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife, portal access through A
const child = seedId('9a710000', 3); // A's ward, made a minor or adult per test
const kavita = seedId('9a710000', 4);
const AT = '2026-10-01T04:00:00Z';
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };
const STAFF_FIELDS = ['version', 'createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason', 'patientId', 'withdrawnByPatientId'];

async function consent(patientId: string, kind: string, givenAt: string, extra: { given?: boolean; voided?: boolean; documentId?: string } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO consents (id, status, created_at, created_by, updated_by, voided_at, patient_id, kind, notice_version, language, given, given_at, document_id)
     VALUES ($1, 'active', $2, 'dev-reception', 'dev-reception', $3, $4, $5, $6, 'hi', $7, $2, $8)`,
    [id, givenAt, extra.voided ? givenAt : null, patientId, kind, kind === 'privacy_notice' ? 'v2' : null, extra.given ?? true, extra.documentId ?? null],
  );
  return id;
}

const consentDoc = async (patientId: string) =>
  String((await db.query(
    `INSERT INTO documents (id, status, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key, uploaded_at)
     VALUES (gen_random_uuid(), 'ready', 'x', 'x', $1, 'consent', 'form.pdf', 'application/pdf', 1000, md5(random()::text), 'k', now()) RETURNING id`,
    [patientId],
  )).rows[0]?.id);

type Consent = Record<string, unknown> & { id: string };
const list = async (q = '', who: never = A) => (await (await get(`/patient/consents${q}`, who)).json()) as Consent[];

let notice: string, treatment: string, referrer: string, research: string, refused: string, voided: string, doc: string;
let kavitaResearch: string, sitaResearch: string, childResearch: string;

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-con-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-con-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $3, 'system', 'system', $4, $6, 'Ramesh', 'Husband', true), ($2, 'active', $3, 'system', 'system', $5, $6, 'Ramesh', 'Father', true)`,
    [randomUUID(), randomUUID(), AT, sita, child, ramesh],
  );
  doc = await consentDoc(ramesh);
  notice = await consent(ramesh, 'privacy_notice', '2026-01-01T04:00:00Z');
  treatment = await consent(ramesh, 'treatment', '2026-01-02T04:00:00Z', { documentId: doc });
  referrer = await consent(ramesh, 'share_with_referrer', '2026-01-03T04:00:00Z');
  research = await consent(ramesh, 'research', '2026-01-04T04:00:00Z');
  refused = await consent(ramesh, 'research', '2026-01-05T04:00:00Z', { given: false });
  voided = await consent(ramesh, 'research', '2026-01-06T04:00:00Z', { voided: true });
  kavitaResearch = await consent(kavita, 'research', '2026-01-01T04:00:00Z');
  sitaResearch = await consent(sita, 'research', '2026-01-01T04:00:00Z');
  childResearch = await consent(child, 'research', '2026-01-01T04:00:00Z');
});

describe('GET /patient/consents', () => {
  it('own consents newest first, voided left out, what each covers, no staff fields', async () => {
    const res = await get('/patient/consents');
    expect(res.status).toBe(200);
    const items = (await res.json()) as Consent[];
    expect(items.map((c) => c.id)).toEqual([refused, research, referrer, treatment, notice]);
    expect(items.map((c) => c.id)).not.toContain(voided);
    const name = String((await db.query('SELECT name FROM patients WHERE id = $1', [ramesh])).rows[0]!.name);
    expect(items.find((c) => c.id === treatment)).toEqual({
      id: treatment, kind: 'treatment', covers: 'Treatment at the hospital', status: 'active', language: 'hi',
      givenAt: '2026-01-02T04:00:00.000Z', givenBy: name, withdrawable: false, documentId: doc,
    });
    expect(items.find((c) => c.id === notice)).toMatchObject({ noticeVersion: 'v2', withdrawable: false });
    expect(items.find((c) => c.id === refused)).toMatchObject({ status: 'refused', withdrawable: false });
    expect(items.find((c) => c.id === research)).toMatchObject({ status: 'active', withdrawable: true });
    for (const c of items) for (const k of STAFF_FIELDS) expect(c).not.toHaveProperty(k);
    expect(JSON.stringify(items)).not.toContain('dev-reception');
  });

  it('a sensitive label hides the signed form; the covers text is generic either way', async () => {
    const before = await list();
    await db.query("UPDATE patients SET labels = '[\"hiv\"]' WHERE id = $1", [ramesh]);
    try {
      const after = await list();
      expect(after.find((c) => c.id === treatment)).not.toHaveProperty('documentId');
      expect(after.map((c) => c.covers)).toEqual(before.map((c) => c.covers));
      expect(JSON.stringify(after)).not.toMatch(/hiv|HIV/);
    } finally {
      await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [ramesh]);
    }
  });

  it("a family member's list; another patient's ID is the generic 403", async () => {
    expect((await list(`?patientId=${sita}`)).map((c) => c.id)).toEqual([sitaResearch]);
    for (const other of [kavita, seedId('9a710000', 999), 'nope']) {
      const res = await get(`/patient/consents?patientId=${other}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await list('', B)).map((c) => c.id)).toEqual([kavitaResearch]);
  });
});

describe('POST /patient/consents/{id}/withdraw', () => {
  it("another patient's, unknown, voided or bad ids are the generic 403", async () => {
    for (const id of [kavitaResearch, randomUUID(), voided, 'nope']) {
      const res = await withdraw(id, { reason: 'x' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await withdraw(research, {}, B)).status).toBe(403);
  });

  it('treatment and privacy notice consents are 422 not_withdrawable; a refusal is 422 not_given; nothing changes', async () => {
    for (const id of [treatment, notice]) {
      const res = await withdraw(id);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'not_withdrawable' });
    }
    const res = await withdraw(refused);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'not_given' });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM consents WHERE id IN ($1, $2, $3) AND withdrawn_at IS NOT NULL', [treatment, notice, refused]);
    expect(rows[0]!.n).toBe(0);
  });

  it('withdraws: 200, row kept with when, why and who; old version kept; audited; twice is 409', async () => {
    const res = await withdraw(research, { reason: 'I no longer want to take part' });
    expect(res.status).toBe(200);
    const c = (await res.json()) as Consent;
    const name = String((await db.query('SELECT name FROM patients WHERE id = $1', [ramesh])).rows[0]!.name);
    expect(c).toMatchObject({ id: research, kind: 'research', status: 'withdrawn', withdrawable: false, withdrawnReason: 'I no longer want to take part', withdrawnBy: name });
    expect(Date.now() - new Date(String(c.withdrawnAt)).getTime()).toBeLessThan(60_000);
    for (const k of STAFF_FIELDS) expect(c).not.toHaveProperty(k);

    const row = (await db.query('SELECT status, version, given, voided_at, withdrawn_by_patient_id::text AS by FROM consents WHERE id = $1', [research])).rows[0]!;
    expect(row).toEqual({ status: 'withdrawn', version: 2, given: true, voided_at: null, by: ramesh });
    expect((await db.query('SELECT count(*)::int AS n FROM consents_versions WHERE record_id = $1', [research])).rows[0]!.n).toBe(1);

    const audit = await db.query(
      "SELECT action, role, patient_id::text AS patient_id, reason FROM audit_events WHERE record_type = 'consent' AND record_id = $1",
      [research],
    );
    expect(audit.rows).toEqual([{ action: 'update', role: 'patient', patient_id: ramesh, reason: 'I no longer want to take part' }]);

    const again = await withdraw(research);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_withdrawn' });
    expect((await list()).find((x) => x.id === research)).toMatchObject({ status: 'withdrawn', withdrawnBy: name });
  });

  it('no reason is fine; an unknown body field is 422', async () => {
    expect((await withdraw(referrer, { why: 'x' })).status).toBe(422);
    const res = await withdraw(referrer);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('withdrawnReason');
  });

  it('a parent withdraws for a minor; not for an adult family member (403 adult_family_member)', async () => {
    const res = await withdraw(sitaResearch);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'adult_family_member' });

    const tenYearsAgo = `${new Date().getUTCFullYear() - 10}-06-15`;
    await db.query('UPDATE patients SET dob = $2 WHERE id = $1', [child, '1990-01-01']);
    expect((await withdraw(childResearch)).status).toBe(403);
    await db.query('UPDATE patients SET dob = $2 WHERE id = $1', [child, tenYearsAgo]);
    const ok = await withdraw(childResearch, { reason: 'parent decision' });
    expect(ok.status).toBe(200);
    const name = String((await db.query('SELECT name FROM patients WHERE id = $1', [ramesh])).rows[0]!.name);
    expect(await ok.json()).toMatchObject({ status: 'withdrawn', withdrawnBy: name });
  });
});
