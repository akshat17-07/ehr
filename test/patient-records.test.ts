import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { auditHash } from '../src/audit/log.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #251 /patient/insurance, #252 GET /patient/record-requests, #253 POST /patient/record-requests, #254 /patient/access-log.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const A = asPatient('pt-rec-ramesh');
const B = asPatient('pt-rec-kavita');
const doctor = asStaff('dev-doctor', ['doctor']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, who: never) => app.request(path, {}, who);
const post = (body: unknown, who: never = A) => app.request('/patient/record-requests', json(body), who);

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife, with portal access through A
const kavita = seedId('9a710000', 4);
const insurer = (n: number) => seedId('1a000000', n);
const tpa = (n: number) => seedId('1b000000', n);
const AT = '2026-10-01T04:00:00Z';
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };
const STAFF_FIELDS = ['version', 'createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason'];

async function insertPolicy(patientId: string, policyNo: string, extra: { voided?: boolean; tpaId?: string; documentIds?: string[] } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_at, created_by, updated_by, voided_at, patient_id, insurer_id, tpa_id, policy_no, member_id, holder_name,
       valid_from, valid_to, sum_insured_paise, document_ids)
     VALUES ($1, $2, $3, 'dev-reception', 'dev-reception', $4, $5, $6, $7, $8, 'M-1', 'Ramesh Kumar', '2026-04-01', '2027-03-31', 50000000, $9)`,
    [id, extra.voided ? 'void' : 'active', AT, extra.voided ? AT : null, patientId, insurer(1), extra.tpaId ?? null, policyNo, JSON.stringify(extra.documentIds ?? [])],
  );
  return id;
}

async function insertClaim(patientId: string, policyId: string, status: string, createdAt: string, voided = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO claims (id, status, created_at, created_by, updated_by, voided_at, patient_id, policy_id, insurer_id, kind, amount_claimed_paise,
       amount_approved_paise, document_ids, submitted_at)
     VALUES ($1, $2, $3, 'dev-tpa', 'dev-tpa', $4, $5, $6, $7, 'reimbursement', 2500000, $8, '[]', $3)`,
    [id, status, createdAt, voided ? createdAt : null, patientId, policyId, insurer(1), status === 'approved' ? 2000000 : null],
  );
  return id;
}

async function insertEvent(claimId: string, toStatus: string, at: string, note: string | null, amountPaise: number | null = null, voided = false) {
  await db.query(
    `INSERT INTO claim_events (id, status, created_at, created_by, updated_by, voided_at, claim_id, to_status, note, amount_paise)
     VALUES ($1, 'active', $2, 'dev-tpa', 'dev-tpa', $3, $4, $5, $6, $7)`,
    [randomUUID(), at, voided ? at : null, claimId, toStatus, note, amountPaise],
  );
}

const withLabel = async (patientId: string, fn: () => Promise<void>) => {
  await db.query("UPDATE patients SET labels = '[\"hiv\"]' WHERE id = $1", [patientId]);
  try {
    await fn();
  } finally {
    await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [patientId]);
  }
};

let policy: string, voidedPolicy: string, claim: string, olderClaim: string, kavitaPolicy: string;
let rameshVisit: string, voidedVisit: string, kavitaVisit: string;

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-rec-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-rec-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $2, 'system', 'system', $3, $4, 'Ramesh', 'Husband', true)`,
    [randomUUID(), AT, sita, ramesh],
  );
  await db.query("UPDATE patients SET email = 'ramesh@example.in' WHERE id = $1", [ramesh]);

  const visit = async (patientId: string) => {
    const res = await app.request('/staff/encounters', json({ patientId, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) }), doctor);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  rameshVisit = await visit(ramesh);
  voidedVisit = await visit(ramesh);
  await db.query('UPDATE encounters SET voided_at = now() WHERE id = $1', [voidedVisit]);
  kavitaVisit = await visit(kavita);

  policy = await insertPolicy(ramesh, 'POL-1', { tpaId: tpa(1), documentIds: [randomUUID()] });
  voidedPolicy = await insertPolicy(ramesh, 'POL-OLD', { voided: true });
  kavitaPolicy = await insertPolicy(kavita, 'POL-K');

  olderClaim = await insertClaim(ramesh, policy, 'submitted', '2026-10-02T04:00:00Z');
  claim = await insertClaim(ramesh, policy, 'approved', '2026-10-05T04:00:00Z');
  await insertEvent(claim, 'submitted', '2026-10-05T05:00:00Z', null);
  await insertEvent(claim, 'query', '2026-10-06T05:00:00Z', 'Insurer asks for the ICTC HIV report');
  await insertEvent(claim, 'submitted', '2026-10-06T09:00:00Z', 'Wrong entry', null, true);
  await insertEvent(claim, 'approved', '2026-10-07T05:00:00Z', 'Approved after review', 2000000);
  await insertClaim(ramesh, policy, 'draft', '2026-10-08T04:00:00Z');
  await insertClaim(ramesh, policy, 'submitted', '2026-10-09T04:00:00Z', true);
  await insertClaim(kavita, kavitaPolicy, 'submitted', '2026-10-03T04:00:00Z');
});

type Insurance = { policies: Record<string, unknown>[]; claims: (Record<string, unknown> & { events: Record<string, unknown>[] })[] };
const insurance = async (q = '', who: never = A) => (await (await get(`/patient/insurance${q}`, who)).json()) as Insurance;

describe('GET /patient/insurance', () => {
  it('own policies and claims with insurer and TPA names; voided and draft rows left out; no staff fields', async () => {
    const res = await get('/patient/insurance', A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Insurance;
    expect(body.policies.map((p) => p.id)).toEqual([policy]);
    expect(body.policies.map((p) => p.id)).not.toContain(voidedPolicy);
    expect(body.policies[0]).toEqual({
      id: policy, status: 'active', patientId: ramesh, insurerId: insurer(1), insurerName: 'Star Health and Allied Insurance',
      tpaId: tpa(1), tpaName: 'Medi Assist', policyNo: 'POL-1', memberId: 'M-1', holderName: 'Ramesh Kumar',
      validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 50000000, documentIds: [],
    });
    expect(body.claims.map((c) => c.id)).toEqual([claim, olderClaim]);
    const c = body.claims[0]!;
    expect(c).toMatchObject({ status: 'approved', policyId: policy, kind: 'reimbursement', amountClaimedPaise: 2500000, amountApprovedPaise: 2000000 });
    expect(c.events).toEqual([
      { status: 'submitted', at: '2026-10-05T05:00:00.000Z' },
      { status: 'query', at: '2026-10-06T05:00:00.000Z', note: 'Insurer asks for the ICTC HIV report' },
      { status: 'approved', at: '2026-10-07T05:00:00.000Z', amountPaise: 2000000, note: 'Approved after review' },
    ]);
    for (const x of [...body.policies, ...body.claims]) for (const k of STAFF_FIELDS) expect(x).not.toHaveProperty(k);
    expect(JSON.stringify(body)).not.toMatch(/dev-tpa|dev-reception|"by"|claimId|Wrong entry/);
  });

  it('a sensitive label drops the claim step notes; amounts and statuses stay', async () => {
    await withLabel(ramesh, async () => {
      const body = await insurance();
      expect(body.claims[0]!.events).toEqual([
        { status: 'submitted', at: '2026-10-05T05:00:00.000Z' },
        { status: 'query', at: '2026-10-06T05:00:00.000Z' },
        { status: 'approved', at: '2026-10-07T05:00:00.000Z', amountPaise: 2000000 },
      ]);
      expect(JSON.stringify(body)).not.toMatch(/HIV|ICTC|review/);
      expect(body.policies.map((p) => p.id)).toEqual([policy]);
    });
  });

  it("a family member's (none here) is empty; another patient's ID is the generic 403", async () => {
    expect(await insurance(`?patientId=${sita}`)).toEqual({ policies: [], claims: [] });
    for (const other of [kavita, seedId('9a710000', 999), 'nope']) {
      const res = await get(`/patient/insurance?patientId=${other}`, A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await insurance('', B)).policies.map((p) => p.id)).toEqual([kavitaPolicy]);
  });
});

type Req = Record<string, unknown> & { id: string; createdAt: string; dueBy: string };

describe('POST /patient/record-requests', () => {
  it('201, due exactly 72 h later, to the email on file; audited', async () => {
    const res = await post({ scope: 'full' });
    expect(res.status).toBe(201);
    const r = (await res.json()) as Req;
    expect(r).toMatchObject({ status: 'pending', patientId: ramesh, requestedBy: 'patient', scope: 'full', includeSensitive: false, email: 'ramesh@example.in' });
    expect(new Date(r.dueBy).getTime() - new Date(r.createdAt).getTime()).toBe(72 * 3_600_000);
    for (const k of STAFF_FIELDS) expect(r).not.toHaveProperty(k);

    const { rows } = await db.query(
      "SELECT patient_id::text AS patient_id, action, role FROM audit_events WHERE record_type = 'record_request' AND record_id = $1",
      [r.id],
    );
    expect(rows).toEqual([{ patient_id: ramesh, action: 'create', role: 'patient' }]);
    // The staff queue sees it.
    const staff = (await (await get('/staff/record-requests?status=pending', asStaff('dev-admin', ['admin']))).json()) as { items: Req[] };
    expect(staff.items.map((x) => x.id)).toContain(r.id);
  });

  it('the same pending request again is 409 already_pending', async () => {
    const res = await post({ scope: 'full', email: 'other@example.in' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_pending' });
  });

  it("encounterIds must be the patient's live visits: another patient's, voided or unknown ones are 422", async () => {
    for (const id of [kavitaVisit, voidedVisit, randomUUID()]) {
      const res = await post({ scope: 'encounter', encounterIds: [rameshVisit, id] });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'validation_failed', message: "encounterIds: not this patient's" });
    }
    expect((await post({ scope: 'encounter' })).status).toBe(422);
    expect((await post({ scope: 'documents', encounterIds: [rameshVisit] })).status).toBe(422);
    const res = await post({ scope: 'encounter', encounterIds: [rameshVisit], email: 'r2@example.in' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ scope: 'encounter', encounterIds: [rameshVisit], email: 'r2@example.in' });
  });

  it('a family member: needs an email when none is on file; includeSensitive only for your own record', async () => {
    const noEmail = await post({ patientId: sita, scope: 'documents' });
    expect(noEmail.status).toBe(422);
    expect(await noEmail.json()).toMatchObject({ message: expect.stringMatching(/^email:/) });
    expect((await post({ patientId: sita, scope: 'documents', email: 's@example.in', includeSensitive: true })).status).toBe(422);
    const ok = await post({ patientId: sita, scope: 'documents', email: 's@example.in' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ patientId: sita, email: 's@example.in', includeSensitive: false });
    expect((await post({ scope: 'documents', includeSensitive: true })).status).toBe(201);
  });

  it("another patient's, unknown or bad patientId is the generic 403, even with a bad body; bad scope is 422", async () => {
    for (const other of [kavita, seedId('9a710000', 999), 'nope', 42]) {
      const res = await post({ patientId: other, scope: 'everything' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await post({ scope: 'everything' })).status).toBe(422);
    expect((await post({ scope: 'full', extra: 1 })).status).toBe(422);
  });
});

describe('GET /patient/record-requests', () => {
  it("own requests (counter and portal) newest first, voided left out, no staff fields; others' are 403", async () => {
    const counter = randomUUID();
    const voided = randomUUID();
    await db.query(
      `INSERT INTO record_requests (id, status, created_at, updated_at, created_by, updated_by, voided_at, patient_id, requested_by, scope, include_sensitive, email)
       VALUES ($1, 'fulfilled', '2026-09-01T04:00:00Z', '2026-09-01T04:00:00Z', 'dev-reception', 'dev-reception', NULL, $3, 'counter', 'full', false, 'r@example.in'),
              ($2, 'pending', '2026-09-02T04:00:00Z', '2026-09-02T04:00:00Z', 'dev-reception', 'dev-reception', '2026-09-02T05:00:00Z', $3, 'counter', 'full', false, 'r@example.in')`,
      [counter, voided, ramesh],
    );
    const res = await get('/patient/record-requests', A);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Req[];
    expect(list.length).toBe(4);
    expect(list.at(-1)).toMatchObject({ id: counter, requestedBy: 'counter', status: 'fulfilled', dueBy: '2026-09-04T04:00:00.000Z' });
    expect(list.map((r) => r.id)).not.toContain(voided);
    const times = list.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    for (const r of list) for (const k of STAFF_FIELDS) expect(r).not.toHaveProperty(k);
    expect(JSON.stringify(list)).not.toContain('dev-reception');

    expect(((await (await get(`/patient/record-requests?patientId=${sita}`, A)).json()) as Req[]).map((r) => r.patientId)).toEqual([sita]);
    expect(await (await get('/patient/record-requests', B)).json()).toEqual([]);
    for (const other of [kavita, 'nope']) {
      const r = await get(`/patient/record-requests?patientId=${other}`, A);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(generic403);
    }
  });
});

/** An audit row at a set time, chained like appendAudit does. */
async function addAudit(at: string, userId: string, role: string, action: string, patientId: string, recordType = 'patient') {
  const { rows } = await db.query('SELECT seq::text AS seq_text, hash FROM audit_events ORDER BY audit_events.seq DESC LIMIT 1');
  const e = {
    seq: Number(rows[0]!.seq_text) + 1, id: randomUUID(), at, userId, role, action: action as 'view', patientId, recordType,
    recordId: 'secret-record', reason: 'secret reason', ip: '10.9.8.7', device: 'secret-device', prevHash: String(rows[0]!.hash),
  };
  await db.query(
    `INSERT INTO audit_events (seq, id, at, user_id, role, action, patient_id, record_type, record_id, changes, reason, ip, device, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13, $14)`,
    [e.seq, e.id, e.at, e.userId, e.role, e.action, e.patientId, e.recordType, e.recordId, e.reason, e.ip, e.device, e.prevHash, auditHash(e)],
  );
}

type LogPage = { items: Record<string, unknown>[]; nextCursor?: string };

describe('GET /patient/access-log', () => {
  beforeAll(async () => {
    await addAudit('2025-03-01T05:00:00Z', 'dev-doctor', 'doctor', 'view', ramesh);
    await addAudit('2025-03-02T05:00:00Z', 'pt-rec-ramesh', 'patient', 'view', ramesh); // own portal use: left out
    await addAudit('2025-03-03T05:00:00Z', 'dev-admin', 'admin', 'update', ramesh);
    await addAudit('2025-03-04T05:00:00Z', 'dev-doctor', 'doctor', 'create', ramesh, 'break_glass_event');
    await addAudit('2025-03-05T05:00:00Z', 'dev-doctor', 'doctor', 'view', kavita); // someone else
    await addAudit('2025-03-06T05:00:00Z', 'dev-doctor', 'doctor', 'print', ramesh);
  });

  it('staff name, role and action only, newest first; own portal use and other patients left out; paging and India-day dates', async () => {
    const res = await get('/patient/access-log?from=2025-03-01&to=2025-03-31', A);
    expect(res.status).toBe(200);
    const page = (await res.json()) as LogPage;
    expect(page).toEqual({
      items: [
        { at: '2025-03-06T05:00:00.000Z', userName: 'Dr Neha Gupta', role: 'doctor', action: 'print' },
        { at: '2025-03-04T05:00:00.000Z', userName: 'Dr Neha Gupta', role: 'doctor', action: 'emergency_access' },
        { at: '2025-03-03T05:00:00.000Z', userName: 'Asha Verma', role: 'admin', action: 'update' },
        { at: '2025-03-01T05:00:00.000Z', userName: 'Dr Neha Gupta', role: 'doctor', action: 'view' },
      ],
    });
    expect(JSON.stringify(page)).not.toMatch(/dev-|secret|10\.9\.8\.7|a0000000/);

    const first = (await (await get('/patient/access-log?from=2025-03-01&to=2025-03-31&limit=3', A)).json()) as LogPage;
    expect(first.items.map((i) => i.at)).toEqual(['2025-03-06T05:00:00.000Z', '2025-03-04T05:00:00.000Z', '2025-03-03T05:00:00.000Z']);
    const second = (await (await get(`/patient/access-log?from=2025-03-01&to=2025-03-31&limit=3&cursor=${first.nextCursor}`, A)).json()) as LogPage;
    expect(second).toEqual({ items: [{ at: '2025-03-01T05:00:00.000Z', userName: 'Dr Neha Gupta', role: 'doctor', action: 'view' }] });

    // India days: 2025-03-03 runs 2025-03-02T18:30Z to 2025-03-03T18:30Z.
    const day = (await (await get('/patient/access-log?from=2025-03-03&to=2025-03-04', A)).json()) as LogPage;
    expect(day.items.map((i) => i.action)).toEqual(['emergency_access', 'update']);
    expect((await get('/patient/access-log?from=03-03-2025', A)).status).toBe(422);
  });

  it('real staff requests show up; portal requests never do', async () => {
    expect((await get(`/staff/patients/${ramesh}`, doctor)).status).toBe(200);
    const page = (await (await get('/patient/access-log?limit=100', A)).json()) as LogPage;
    expect(page.items[0]).toMatchObject({ userName: 'Dr Neha Gupta', role: 'doctor', action: 'view' });
    expect(page.items.every((i) => i.role !== 'patient')).toBe(true);
  });

  it("a family member's log; another patient's ID is the generic 403", async () => {
    expect((await get(`/patient/access-log?patientId=${sita}`, A)).status).toBe(200);
    for (const other of [kavita, 'nope']) {
      const res = await get(`/patient/access-log?patientId=${other}`, A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    const kav = (await (await get('/patient/access-log?from=2025-03-01&to=2025-03-31', B)).json()) as LogPage;
    expect(kav.items).toEqual([{ at: '2025-03-05T05:00:00.000Z', userName: 'Dr Neha Gupta', role: 'doctor', action: 'view' }]);
  });
});
