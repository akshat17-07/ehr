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
const irfan = seedId('9a710000', 3);
const star = seedId('1a000000', 1);
const mediAssist = seedId('1b000000', 1);

/** A policy row straight in the table (POST /policies comes at #132). */
async function insertPolicy(patientId: string, policyNo: string, validFrom: string, validTo: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, holder_name, valid_from, valid_to, sum_insured_paise)
     VALUES ($1, 'active', 'test', 'test', $2, $3, $4, $5, 'Irfan Khan', $6, $7, 50000000)`,
    [id, patientId, star, mediAssist, policyNo, validFrom, validTo],
  );
  return id;
}

describe('GET /staff/patients/{id}/policies', () => {
  it('lists the policies; active picks those in force today', async () => {
    const old = await insertPolicy(irfan, 'P-OLD', '2020-01-01', '2020-12-31');
    const now = await insertPolicy(irfan, 'P-NOW', '2020-01-01', '2099-12-31');
    const res = await app.request(`/staff/patients/${irfan}/policies`, {}, doctor);
    expect(res.status).toBe(200);
    const all = (await res.json()) as { id: string }[];
    expect(all.map((p) => p.id)).toEqual([now, old]);
    expect(all[0]).toMatchObject({ patientId: irfan, insurerId: star, tpaId: mediAssist, policyNo: 'P-NOW', validFrom: '2020-01-01', validTo: '2099-12-31', sumInsuredPaise: 50000000, documentIds: [] });
    const active = (await (await app.request(`/staff/patients/${irfan}/policies?active=true`, {}, doctor)).json()) as { id: string }[];
    expect(active.map((p) => p.id)).toEqual([now]);
    const expired = (await (await app.request(`/staff/patients/${irfan}/policies?active=false`, {}, doctor)).json()) as { id: string }[];
    expect(expired.map((p) => p.id)).toEqual([old]);
  });

  it('403 for a nurse; 404 for no patient', async () => {
    expect((await app.request(`/staff/patients/${irfan}/policies`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await app.request(`/staff/patients/${seedId('9a710000', 999)}/policies`, {}, doctor)).status).toBe(404);
  });
});

describe('POST /staff/patients/{id}/policies', () => {
  const kavita = seedId('9a710000', 4);
  const add = (patientId: string, body: unknown, who = doctor) =>
    app.request(`/staff/patients/${patientId}/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const body = { insurerId: star, tpaId: mediAssist, policyNo: 'STAR-778', memberId: 'M1', holderName: 'Kavita Sharma', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 50_000_000 };

  it('puts the policy on file; the same number again is a duplicate', async () => {
    const res = await add(kavita, body);
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string };
    expect(made).toMatchObject({ ...body, patientId: kavita, documentIds: [], createdBy: 'dev-doctor' });
    const again = await add(kavita, body);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'duplicate', policyId: made.id });
    expect(((await (await app.request(`/staff/patients/${kavita}/policies`, {}, doctor)).json()) as { id: string }[]).map((p) => p.id)).toContain(made.id);
  });

  it('422 for an unknown insurer, backwards dates or a document not of this patient; 403 for a nurse', async () => {
    expect((await add(kavita, { ...body, policyNo: 'X1', insurerId: seedId('1a000000', 99) })).status).toBe(422);
    expect((await add(kavita, { ...body, policyNo: 'X2', tpaId: seedId('1b000000', 99) })).status).toBe(422);
    expect((await add(kavita, { ...body, policyNo: 'X3', validTo: '2026-01-01' })).status).toBe(422);
    expect((await add(kavita, { ...body, policyNo: 'X4', documentIds: [seedId('d0c00000', 99)] })).status).toBe(422);
    expect((await add(kavita, { ...body, policyNo: 'X5' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('PATCH /staff/policies/{id}', () => {
  const rahul = seedId('9a710000', 5);
  const patch = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/policies/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('changes the fields given, clears with null, and keeps the old version', async () => {
    const made = (await (
      await app.request(`/staff/patients/${rahul}/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ insurerId: star, tpaId: mediAssist, policyNo: 'R-1', holderName: 'Rahul', validFrom: '2026-01-01', validTo: '2026-12-31' }) }, doctor)
    ).json()) as { id: string; version: number };
    const res = await patch(made.id, { version: made.version, validTo: '2027-12-31', tpaId: null, memberId: 'MEM-9', reason: 'Renewed' });
    expect(res.status).toBe(200);
    const changed = (await res.json()) as { version: number; tpaId?: string };
    expect(changed).toMatchObject({ validTo: '2027-12-31', memberId: 'MEM-9', policyNo: 'R-1', version: made.version + 1 });
    expect(changed.tpaId).toBeUndefined();
    expect(await (await patch(made.id, { version: made.version, holderName: 'Old' })).json()).toMatchObject({ error: 'conflict' });
    expect((await patch(made.id, { version: changed.version, validFrom: '2028-01-01' })).status).toBe(422);
    expect((await patch(made.id, { version: changed.version })).status).toBe(422);
    expect((await patch(made.id, { version: changed.version, holderName: 'X' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await patch(seedId('9b000000', 999), { version: 1, holderName: 'X' })).status).toBe(404);
  });
});

const post = (path: string, body: unknown, who = doctor) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const ramesh = seedId('9a710000', 1);
const rameshPolicy = await (async () => {
  const res = await post(`/staff/patients/${ramesh}/policies`, { insurerId: star, tpaId: mediAssist, policyNo: 'RAM-1', holderName: 'Ramesh', validFrom: '2026-01-01', validTo: '2099-12-31' });
  return ((await res.json()) as { id: string }).id;
})();

describe('POST /staff/claims', () => {
  it('a draft claim on the patient\'s policy', async () => {
    const res = await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'cashless_preauth', amountClaimedPaise: 5_000_000 });
    expect(res.status).toBe(201);
    const claim = (await res.json()) as { dueBy?: string };
    expect(claim).toMatchObject({ status: 'draft', patientId: ramesh, policyId: rameshPolicy, insurerId: star, kind: 'cashless_preauth', amountClaimedPaise: 5_000_000, events: [], documentIds: [] });
    expect(claim.dueBy).toBeUndefined();
  });

  it("422 for another patient's policy or admission; 403 for a nurse; 404 for no patient", async () => {
    expect((await post('/staff/claims', { patientId: irfan, policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 100 })).status).toBe(422);
    expect((await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, admissionId: seedId('ad000000', 99), kind: 'reimbursement', amountClaimedPaise: 100 })).status).toBe(422);
    expect((await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 100 }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await post('/staff/claims', { patientId: seedId('9a710000', 999), policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 100 })).status).toBe(404);
  });
});

describe('GET /staff/claims', () => {
  const claim = async (kind: string) => ((await (await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind, amountClaimedPaise: 1000 })).json()) as { id: string }).id;
  const submittedAgo = (id: string, minutes: number) =>
    db.query(`UPDATE claims SET status = 'submitted', submitted_at = $2 WHERE id = $1`, [id, new Date(Date.now() - minutes * 60_000)]);
  const list = async (q: string) => ((await (await app.request(`/staff/claims${q}`, {}, doctor)).json()) as { items: { id: string; dueBy?: string }[] }).items;

  it('filters by status, insurer and the IRDAI timers', async () => {
    const late = await claim('cashless_preauth');
    const fresh = await claim('cashless_preauth');
    const discharge = await claim('cashless_final');
    await submittedAgo(late, 61);
    await submittedAgo(fresh, 10);
    await submittedAgo(discharge, 120);
    const overdue = await list(`?overdue=true&patientId=${ramesh}`);
    expect(overdue.map((c) => c.id)).toEqual([late]);
    const notLate = (await list(`?overdue=false&patientId=${ramesh}`)).map((c) => c.id);
    expect(notLate).toEqual(expect.arrayContaining([fresh, discharge]));
    expect(notLate).not.toContain(late);
    const submitted = await list('?status=submitted');
    expect(submitted.map((c) => c.id).sort()).toEqual([discharge, fresh, late].sort());
    expect(submitted.find((c) => c.id === fresh)?.dueBy).toBeDefined();
    expect(await list(`?insurerId=${seedId('1a000000', 2)}`)).toEqual([]);
    expect((await app.request('/staff/claims', {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/claims/{id}', () => {
  it('one claim, audited as a view; 404 for none; 403 for a nurse', async () => {
    const made = (await (await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 2500 })).json()) as { id: string };
    const res = await app.request(`/staff/claims/${made.id}`, {}, doctor);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(made);
    const { rows } = await db.query('SELECT action, patient_id FROM audit_events WHERE record_id = $1 ORDER BY seq DESC LIMIT 1', [made.id]);
    expect(rows[0]).toMatchObject({ action: 'view', patient_id: ramesh });
    expect((await app.request(`/staff/claims/${seedId('c1a00000', 999)}`, {}, doctor)).status).toBe(404);
    expect((await app.request(`/staff/claims/${made.id}`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/claims/{id}/events', () => {
  const step = (id: string, body: unknown, who = doctor) => post(`/staff/claims/${id}/events`, body, who);

  it('walks a claim from submitted to settled, starting the IRDAI timer', async () => {
    const made = (await (await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'cashless_preauth', amountClaimedPaise: 9000 })).json()) as { id: string };
    const res = await step(made.id, { status: 'submitted', note: 'Pre-auth form sent to TPA' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ claimId: made.id, status: 'submitted', note: 'Pre-auth form sent to TPA', by: 'dev-doctor', at: expect.any(String) });
    const sent = (await (await app.request(`/staff/claims/${made.id}`, {}, doctor)).json()) as { status: string; dueBy: string; events: unknown[] };
    expect(sent.status).toBe('submitted');
    expect(new Date(sent.dueBy).getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    await step(made.id, { status: 'query', note: 'Asked for the X-ray' });
    await step(made.id, { status: 'submitted' });
    expect((await step(made.id, { status: 'approved', amountPaise: 9001 })).status).toBe(422);
    await step(made.id, { status: 'approved', amountPaise: 8000 });
    await step(made.id, { status: 'settled', amountPaise: 8000 });
    const done = (await (await app.request(`/staff/claims/${made.id}`, {}, doctor)).json()) as { status: string; amountApprovedPaise: number; dueBy?: string; events: { status: string }[] };
    expect(done).toMatchObject({ status: 'settled', amountApprovedPaise: 8000 });
    expect(done.dueBy).toBeUndefined();
    expect(done.events.map((e) => e.status)).toEqual(['submitted', 'query', 'submitted', 'approved', 'settled']);
    expect(await (await step(made.id, { status: 'query' })).json()).toMatchObject({ error: 'bad_move', allowed: [] });
  });

  it('409 for a draft going straight to approved; 422 without an amount; 403 for a nurse; 404 for no claim', async () => {
    const made = (await (await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 9000 })).json()) as { id: string };
    expect(await (await step(made.id, { status: 'approved', amountPaise: 100 })).json()).toMatchObject({ error: 'bad_move', allowed: ['submitted'] });
    expect((await step(made.id, { status: 'settled' })).status).toBe(422);
    expect((await step(made.id, { status: 'submitted' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await step(seedId('c1a00000', 999), { status: 'submitted' })).status).toBe(404);
  });
});

describe('POST /staff/claims/{id}/documents', () => {
  /** A ready document row straight in the table (the upload flow is tested in documents.test). */
  const document = async (patientId: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO documents (id, status, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key)
       VALUES ($1, 'ready', 'test', 'test', $2, 'insurance', 'card.pdf', 'application/pdf', 100, $3, $4)`,
      [id, patientId, randomUUID().replace(/-/g, '').padEnd(64, '0'), `test/${id}`],
    );
    return id;
  };

  it("adds the patient's documents once each; 422 for another patient's", async () => {
    const made = (await (await post('/staff/claims', { patientId: ramesh, policyId: rameshPolicy, kind: 'reimbursement', amountClaimedPaise: 100 })).json()) as { id: string };
    const a = await document(ramesh);
    const b = await document(ramesh);
    const res = await post(`/staff/claims/${made.id}/documents`, { documentIds: [a] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ documentIds: [a] });
    expect(await (await post(`/staff/claims/${made.id}/documents`, { documentIds: [a, b] })).json()).toMatchObject({ documentIds: [a, b] });
    expect((await post(`/staff/claims/${made.id}/documents`, { documentIds: [await document(irfan)] })).status).toBe(422);
    expect((await post(`/staff/claims/${made.id}/documents`, { documentIds: [a] }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await post(`/staff/claims/${seedId('c1a00000', 999)}/documents`, { documentIds: [a] })).status).toBe(404);
  });
});

describe('POST /staff/patients/{id}/agent-links', () => {
  const agent = seedId('a0000000', 9);
  const sita = seedId('9a710000', 2);
  const link = (patientId: string, body: unknown, who = doctor) => post(`/staff/patients/${patientId}/agent-links`, body, who);

  it('links an insurance agent from today; a second open link is a duplicate', async () => {
    const res = await link(sita, { agentUserId: agent, to: '2099-01-31' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; from: string };
    expect(made).toMatchObject({ status: 'active', patientId: sita, agentUserId: agent, to: '2099-01-31' });
    expect(made.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await (await link(sita, { agentUserId: agent })).json()).toMatchObject({ error: 'duplicate', agentLinkId: made.id });
  });

  it('422 for a user who is not an agent or a past end; 403 for a nurse; 404 for no patient', async () => {
    expect((await link(irfan, { agentUserId: seedId('a0000000', 3) })).status).toBe(422);
    expect((await link(irfan, { agentUserId: agent, to: '2020-01-01' })).status).toBe(422);
    expect((await link(irfan, { agentUserId: agent }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await link(seedId('9a710000', 999), { agentUserId: agent })).status).toBe(404);
  });
});
