import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { yearsBetween } from '../src/modules/patients/patients.js';
import { indiaDate } from '../src/time/india.js';

// #393-#396: /other/insurance/* scoped by the agent's live links.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const agent = asStaff('dev-insurance', ['insurance']);
const doctor = asStaff('dev-doctor', ['doctor']);
const gp = asStaff('dev-gp', ['gp']);
const reception = asStaff('dev-reception', ['staff']);

const star = seedId('1a000000', 1);
const mediAssist = seedId('1b000000', 1);
const [ramesh, sita, irfan, kavita, rahul] = [1, 2, 3, 4, 5].map((n) => seedId('9a710000', n)) as [string, string, string, string, string];

const today = indiaDate();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

const agentId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-insurance'")).rows[0]?.id);

async function link(patientId: string, from: string, to: string | null, voided = false) {
  await db.query(
    `INSERT INTO agent_links (id, status, created_at, created_by, updated_by, patient_id, agent_user_id, from_date, to_date, voided_at, voided_by, void_reason)
     VALUES ($1, $2, '2026-01-01T00:00:00Z', 'test', 'test', $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), voided ? 'void' : 'active', patientId, agentId, from, to, voided ? '2026-01-02T00:00:00Z' : null, voided ? 'test' : null, voided ? 'Wrong agent' : null],
  );
}

async function insertPolicy(patientId: string, policyNo: string, createdAt: string, opts: { validTo?: string; voided?: boolean } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_at, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, holder_name, valid_from, valid_to, voided_at, voided_by, void_reason)
     VALUES ($1, $2, $3, 'test', 'test', $4, $5, $6, $7, 'Holder', '2020-01-01', $8, $9, $10, $11)`,
    [
      id, opts.voided ? 'void' : 'active', createdAt, patientId, star, mediAssist, policyNo, opts.validTo ?? '2099-12-31',
      opts.voided ? '2026-02-01T00:00:00Z' : null, opts.voided ? 'test' : null, opts.voided ? 'Typo' : null,
    ],
  );
  return id;
}

// Ramesh: two live links (one open-ended, one ending tomorrow). Sita: today only. Irfan: a voided link only.
// Kavita: ended yesterday. Rahul: starts tomorrow.
await link(ramesh, yesterday, null);
await link(ramesh, today, tomorrow);
await link(sita, today, today);
await link(irfan, '2026-01-01', null, true);
await link(kavita, '2026-01-01', yesterday);
await link(rahul, tomorrow, null);

// A linked patient who is then voided.
const ghost = await (async () => {
  const res = await app.request(
    '/staff/patients',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Aaron Voided', sex: 'M', ageYears: 30 }) },
    reception,
  );
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await link(id, yesterday, null);
  await db.query("UPDATE patients SET voided_at = '2026-03-01T00:00:00Z', voided_by = 'test', void_reason = 'Duplicate' WHERE id = $1", [id]);
  return id;
})();

const json = { 'content-type': 'application/json' };
const get = (path: string, who = agent) => app.request(`/other/insurance${path}`, {}, who);
const post = (path: string, body: unknown, who = agent) => app.request(`/other/insurance${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }, who);
const patch = (path: string, body: unknown, who = agent) => app.request(`/other/insurance${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) }, who);

const FORBIDDEN = { error: 'forbidden', message: 'not a patient linked to this agent' };
const STAFF_FIELDS = ['createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason'];
const policyBody = { insurerId: star, tpaId: mediAssist, policyNo: 'AG-1', memberId: 'M-7', holderName: 'Ramesh Kumar Sharma', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 30_000_000 };

type Item = { patientId: string; uhid: string; name: string; sex: string; ageYears?: number };
const list = async (qs = '') => {
  const res = await get(`/patients${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { items: Item[]; nextCursor?: string };
};

describe('GET /other/insurance/patients (#393)', () => {
  it('lists only live-linked patients by name, once each, with summary fields only', async () => {
    const page = await list();
    expect(page.items.map((p) => p.patientId)).toEqual([ramesh, sita]);
    expect(page.nextCursor).toBeUndefined();
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(['ageYears', 'name', 'patientId', 'sex', 'uhid']);
    expect(page.items[0]).toEqual({ patientId: ramesh, uhid: 'U24000001', name: 'Ramesh Kumar Sharma', sex: 'M', ageYears: yearsBetween('1968-05-14', today) });
  });

  it('q matches name or UHID in any case; pages by cursor', async () => {
    expect((await list('?q=SITA')).items.map((p) => p.patientId)).toEqual([sita]);
    expect((await list('?q=u24000001')).items.map((p) => p.patientId)).toEqual([ramesh]);
    expect((await list('?q=sharma')).items.map((p) => p.patientId)).toEqual([ramesh, sita]);
    expect((await list('?q=irfan')).items).toEqual([]);
    expect((await list('?q=Rahul')).items).toEqual([]);
    const first = await list('?limit=1');
    expect(first.items.map((p) => p.patientId)).toEqual([ramesh]);
    expect(first.nextCursor).toBeDefined();
    const second = await list(`?limit=1&cursor=${first.nextCursor}`);
    expect(second.items.map((p) => p.patientId)).toEqual([sita]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('422 for a bad limit', async () => {
    expect((await get('/patients?limit=0')).status).toBe(422);
  });
});

describe('GET /other/insurance/patients/{id}/policies (#394)', () => {
  it('all non-voided policies newest first, without staff fields', async () => {
    const older = await insertPolicy(ramesh, 'R-OLD', '2026-01-01T00:00:00Z', { validTo: '2025-12-31' });
    const newer = await insertPolicy(ramesh, 'R-NEW', '2026-02-01T00:00:00Z');
    await insertPolicy(ramesh, 'R-VOID', '2026-03-01T00:00:00Z', { voided: true });
    const res = await get(`/patients/${ramesh}/policies`);
    expect(res.status).toBe(200);
    const policies = (await res.json()) as Record<string, unknown>[];
    const ids = policies.map((p) => p.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(ids.indexOf(older)).toBeGreaterThanOrEqual(0);
    expect(policies.some((p) => p.policyNo === 'R-VOID')).toBe(false);
    for (const p of policies) for (const f of STAFF_FIELDS) expect(p).not.toHaveProperty(f);
    expect(policies.find((p) => p.id === newer)).toMatchObject({ version: 1, status: 'active', patientId: ramesh, policyNo: 'R-NEW' });
    const audit = await db.query("SELECT patient_id FROM audit_events WHERE user_id = 'dev-insurance' AND action = 'view' AND record_id = $1", [
      `GET /other/insurance/patients/${ramesh}/policies`,
    ]);
    expect(audit.rows[0]?.patient_id).toBe(ramesh);
  });

  it('a link ending today still works', async () => {
    expect((await get(`/patients/${sita}/policies`)).status).toBe(200);
  });
});

describe('POST /other/insurance/patients/{id}/policies (#395)', () => {
  it('201 with the stripped policy, audited; duplicate 409', async () => {
    const res = await post(`/patients/${sita}/policies`, { ...policyBody, holderName: 'Sita Sharma' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as Record<string, unknown>;
    expect(made).toMatchObject({ ...policyBody, holderName: 'Sita Sharma', patientId: sita, version: 1, documentIds: [] });
    for (const f of STAFF_FIELDS) expect(made).not.toHaveProperty(f);
    const stored = await db.query('SELECT created_by FROM policies WHERE id = $1', [made.id]);
    expect(stored.rows[0]?.created_by).toBe('dev-insurance');
    const audit = await db.query("SELECT action, patient_id FROM audit_events WHERE record_type = 'policy' AND record_id = $1", [made.id]);
    expect(audit.rows[0]).toMatchObject({ action: 'create', patient_id: sita });
    expect((await post(`/patients/${sita}/policies`, { ...policyBody, holderName: 'Sita Sharma' })).status).toBe(409);
  });

  it('422 for a bad body or an unknown insurer', async () => {
    expect((await post(`/patients/${ramesh}/policies`, { ...policyBody, validFrom: 'soon' })).status).toBe(422);
    expect((await post(`/patients/${ramesh}/policies`, { ...policyBody, extra: 1 })).status).toBe(422);
    expect((await post(`/patients/${ramesh}/policies`, { ...policyBody, policyNo: 'AG-X', insurerId: seedId('1a000000', 99) })).status).toBe(422);
  });
});

describe('PATCH /other/insurance/policies/{id} (#396)', () => {
  it('200 with the stripped policy, audited with the reason; stale version 409; bad body 422', async () => {
    const id = await insertPolicy(ramesh, 'R-EDIT', '2026-04-01T00:00:00Z');
    const res = await patch(`/policies/${id}`, { version: 1, memberId: 'MEM-1', reason: 'Card received' });
    expect(res.status).toBe(200);
    const changed = (await res.json()) as Record<string, unknown>;
    expect(changed).toMatchObject({ id, memberId: 'MEM-1', version: 2 });
    for (const f of STAFF_FIELDS) expect(changed).not.toHaveProperty(f);
    const audit = await db.query("SELECT action, patient_id, reason FROM audit_events WHERE record_type = 'policy' AND record_id = $1", [id]);
    expect(audit.rows[0]).toMatchObject({ action: 'update', patient_id: ramesh, reason: 'Card received' });
    const stale = await patch(`/policies/${id}`, { version: 1, holderName: 'Old' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict' });
    expect((await patch(`/policies/${id}`, { version: 2 })).status).toBe(422);
    expect((await patch(`/policies/${id}`, { version: 2, validFrom: 'x' })).status).toBe(422);
  });
});

describe('access: one generic 403', () => {
  const unknown = randomUUID();
  const routes = (patientId: string) => [
    () => get(`/patients/${patientId}/policies`),
    () => post(`/patients/${patientId}/policies`, { ...policyBody, policyNo: `NO-${patientId.slice(0, 8)}` }),
  ];

  it.each([
    ['unlinked (voided link only)', irfan],
    ['expired link', kavita],
    ['future link', rahul],
    ['voided patient', ghost],
    ['unknown uuid', unknown],
    ['malformed id', 'not-a-uuid'],
  ])('%s: 403 forbidden with the same body on every patient route', async (_label, patientId) => {
    for (const call of routes(patientId)) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
    }
  });

  it('the patient list leaves out expired, future, voided-link and voided patients', async () => {
    const ids = (await list()).items.map((p) => p.patientId);
    for (const id of [irfan, kavita, rahul, ghost]) expect(ids).not.toContain(id);
  });

  it('PATCH: unlinked, voided, unknown and malformed policies are the same 403; nothing changes', async () => {
    const foreign = await insertPolicy(irfan, 'I-1', '2026-01-01T00:00:00Z');
    const expired = await insertPolicy(kavita, 'K-1', '2026-01-01T00:00:00Z');
    const voided = await insertPolicy(ramesh, 'R-V2', '2026-01-01T00:00:00Z', { voided: true });
    for (const id of [foreign, expired, voided, randomUUID(), 'nope']) {
      const res = await patch(`/policies/${id}`, { version: 1, holderName: 'Hacked' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
    }
    // Even a bad body is 403 (access is checked first).
    expect((await patch(`/policies/${foreign}`, { bogus: true })).status).toBe(403);
    const row = await db.query('SELECT holder_name, version FROM policies WHERE id = $1', [foreign]);
    expect(row.rows[0]).toMatchObject({ holder_name: 'Holder', version: 1 });
  });

  it('denials are audited as denied, without naming the patient', async () => {
    await get(`/patients/${irfan}/policies`);
    const { rows } = await db.query(
      "SELECT action, patient_id FROM audit_events WHERE user_id = 'dev-insurance' AND record_id = $1 ORDER BY seq DESC LIMIT 1",
      [`GET /other/insurance/patients/${irfan}/policies`],
    );
    expect(rows[0]).toMatchObject({ action: 'denied', patient_id: null });
  });

  it('a doctor or a GP gets 403 on /other/insurance/*', async () => {
    for (const who of [doctor, gp]) {
      expect((await get('/patients', who)).status).toBe(403);
      expect((await get(`/patients/${ramesh}/policies`, who)).status).toBe(403);
      expect((await post(`/patients/${ramesh}/policies`, { ...policyBody, policyNo: 'DOC-1' }, who)).status).toBe(403);
      expect((await patch(`/policies/${randomUUID()}`, { version: 1, holderName: 'X' }, who)).status).toBe(403);
    }
  });
});
