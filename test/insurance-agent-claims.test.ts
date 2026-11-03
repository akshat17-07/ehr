import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

// #397-#399: /other/insurance/claims* scoped by the agent's live links; drafts hidden.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const agent = asStaff('dev-insurance', ['insurance']);
const doctor = asStaff('dev-doctor', ['doctor']);
const reception = asStaff('dev-reception', ['staff']);

const star = seedId('1a000000', 1);
const mediAssist = seedId('1b000000', 1);
const [ramesh, sita, irfan, kavita] = [1, 2, 3, 4].map((n) => seedId('9a710000', n)) as [string, string, string, string];

const today = indiaDate();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);

const agentId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-insurance'")).rows[0]?.id);

async function link(patientId: string, from: string, to: string | null, voided = false) {
  await db.query(
    `INSERT INTO agent_links (id, status, created_at, created_by, updated_by, patient_id, agent_user_id, from_date, to_date, voided_at, voided_by, void_reason)
     VALUES ($1, $2, '2026-01-01T00:00:00Z', 'test', 'test', $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), voided ? 'void' : 'active', patientId, agentId, from, to, voided ? '2026-01-02T00:00:00Z' : null, voided ? 'test' : null, voided ? 'Wrong agent' : null],
  );
}

async function insertPolicy(patientId: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_at, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, holder_name, valid_from, valid_to)
     VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'test', 'test', $2, $3, $4, $5, 'Holder', '2020-01-01', '2099-12-31')`,
    [id, patientId, star, mediAssist, `P-${id.slice(0, 8)}`],
  );
  return id;
}

/** A claim in `status` with one staff event per step, created at `createdAt`. */
async function insertClaim(patientId: string, status: string, createdAt: string, amountClaimedPaise = 5_000_000) {
  const id = randomUUID();
  const policyId = await insertPolicy(patientId);
  await db.query(
    `INSERT INTO claims (id, status, created_at, updated_at, created_by, updated_by, patient_id, policy_id, insurer_id, kind, amount_claimed_paise, submitted_at)
     VALUES ($1, $2, $3, $3, 'dev-tpa', 'dev-tpa', $4, $5, $6, 'reimbursement', $7, $8)`,
    [id, status, createdAt, patientId, policyId, star, amountClaimedPaise, status === 'draft' ? null : createdAt],
  );
  if (status !== 'draft') {
    await db.query(
      `INSERT INTO claim_events (id, status, created_by, updated_by, created_at, updated_at, claim_id, to_status, note)
       VALUES ($1, 'active', 'dev-tpa', 'dev-tpa', $2, $2, $3, 'submitted', 'Sent to TPA')`,
      [randomUUID(), createdAt, id],
    );
  }
  return id;
}

await link(ramesh, yesterday, null);
await link(sita, today, today);
await link(irfan, '2026-01-01', null, true); // voided link only
await link(kavita, '2026-01-01', yesterday); // expired

const stranger = await (async () => {
  const res = await app.request(
    '/staff/patients',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nobody Linked', sex: 'F', ageYears: 40 }) },
    reception,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
})();

const rSubmitted = await insertClaim(ramesh, 'submitted', '2026-02-01T00:00:00Z');
const rQuery = await insertClaim(ramesh, 'query', '2026-02-02T00:00:00Z');
const rDraft = await insertClaim(ramesh, 'draft', '2026-02-03T00:00:00Z');
const sSubmitted = await insertClaim(sita, 'submitted', '2026-02-04T00:00:00Z');
const iSubmitted = await insertClaim(irfan, 'submitted', '2026-02-05T00:00:00Z');
const kSubmitted = await insertClaim(kavita, 'submitted', '2026-02-06T00:00:00Z');
const xSubmitted = await insertClaim(stranger, 'submitted', '2026-02-07T00:00:00Z');

const json = { 'content-type': 'application/json' };
const get = (path: string, who = agent) => app.request(`/other/insurance${path}`, {}, who);
const post = (path: string, body: unknown, who = agent) => app.request(`/other/insurance${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }, who);

const FORBIDDEN = { error: 'forbidden', message: 'not a patient linked to this agent' };
const STAFF_FIELDS = ['createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason'];

type ClaimOut = Record<string, unknown> & { id: string; status: string; events: Record<string, unknown>[] };
const list = async (qs = '') => {
  const res = await get(`/claims${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { items: ClaimOut[]; nextCursor?: string };
};

const expectStripped = (claim: ClaimOut) => {
  for (const f of STAFF_FIELDS) expect(claim).not.toHaveProperty(f);
  for (const e of claim.events) expect(e).not.toHaveProperty('by');
};

describe('GET /other/insurance/claims (#397)', () => {
  it("lists linked patients' non-draft claims newest first, with events, no staff fields", async () => {
    const page = await list();
    expect(page.items.map((c) => c.id)).toEqual([sSubmitted, rQuery, rSubmitted]);
    expect(page.nextCursor).toBeUndefined();
    page.items.forEach(expectStripped);
    expect(page.items[2]).toMatchObject({ id: rSubmitted, version: 1, status: 'submitted', patientId: ramesh, insurerId: star, kind: 'reimbursement', amountClaimedPaise: 5_000_000, documentIds: [] });
    expect(page.items[2]?.events).toEqual([{ id: expect.any(String), claimId: rSubmitted, status: 'submitted', note: 'Sent to TPA', at: '2026-02-01T00:00:00.000Z' }]);
  });

  it('status filter and paging; draft is 422', async () => {
    expect((await list('?status=query')).items.map((c) => c.id)).toEqual([rQuery]);
    expect((await list('?status=submitted')).items.map((c) => c.id)).toEqual([sSubmitted, rSubmitted]);
    const first = await list('?limit=2');
    expect(first.items.map((c) => c.id)).toEqual([sSubmitted, rQuery]);
    const second = await list(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((c) => c.id)).toEqual([rSubmitted]);
    expect(second.nextCursor).toBeUndefined();
    expect((await get('/claims?status=draft')).status).toBe(422);
    expect((await get('/claims?status=bogus')).status).toBe(422);
  });

  it('leaves out drafts and unlinked, voided-link and expired-link claims', async () => {
    const ids = (await list()).items.map((c) => c.id);
    for (const id of [rDraft, iSubmitted, kSubmitted, xSubmitted]) expect(ids).not.toContain(id);
  });
});

describe('GET /other/insurance/claims/{id} (#398)', () => {
  it('the stripped claim with events, audited', async () => {
    const res = await get(`/claims/${rQuery}`);
    expect(res.status).toBe(200);
    const claim = (await res.json()) as ClaimOut;
    expect(claim).toMatchObject({ id: rQuery, status: 'query', patientId: ramesh });
    expect(claim.events).toHaveLength(1);
    expectStripped(claim);
    const audit = await db.query("SELECT action, patient_id FROM audit_events WHERE record_type = 'claim' AND record_id = $1", [rQuery]);
    expect(audit.rows[0]).toMatchObject({ action: 'view', patient_id: ramesh });
  });
});

describe('POST /other/insurance/claims/{id}/events (#399)', () => {
  it('approved with an amount moves the claim; 201 without by; caller stored; audited', async () => {
    const res = await post(`/claims/${rSubmitted}/events`, { status: 'approved', amountPaise: 4_000_000, note: '  Approved by TPA  ' });
    expect(res.status).toBe(201);
    const event = (await res.json()) as Record<string, unknown>;
    expect(event).toEqual({ id: expect.any(String), claimId: rSubmitted, status: 'approved', note: 'Approved by TPA', amountPaise: 4_000_000, at: expect.any(String) });
    const stored = await db.query('SELECT created_by FROM claim_events WHERE id = $1', [event.id]);
    expect(stored.rows[0]?.created_by).toBe('dev-insurance');
    const claim = (await (await get(`/claims/${rSubmitted}`)).json()) as ClaimOut;
    expect(claim).toMatchObject({ status: 'approved', amountApprovedPaise: 4_000_000, version: 2 });
    expect(claim.events.map((e) => e.status)).toEqual(['submitted', 'approved']);
    expectStripped(claim);
    const audit = await db.query("SELECT action, patient_id FROM audit_events WHERE record_type = 'claim' AND record_id = $1 AND action = 'create'", [rSubmitted]);
    expect(audit.rows[0]).toMatchObject({ patient_id: ramesh });
  });

  it('422: settled without amountPaise, submitted, extra field, amount over the claim', async () => {
    expect((await post(`/claims/${rSubmitted}/events`, { status: 'settled' })).status).toBe(422);
    expect((await post(`/claims/${sSubmitted}/events`, { status: 'submitted' })).status).toBe(422);
    expect((await post(`/claims/${sSubmitted}/events`, { status: 'query', extra: 1 })).status).toBe(422);
    expect((await post(`/claims/${sSubmitted}/events`, { status: 'approved', amountPaise: 9_000_000 })).status).toBe(422);
  });

  it('409 bad_move for a move not allowed', async () => {
    const res = await post(`/claims/${sSubmitted}/events`, { status: 'settled', amountPaise: 100 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'bad_move' });
  });
});

describe('access: one generic 403', () => {
  it.each([
    ['unlinked patient', () => xSubmitted],
    ['voided link', () => iSubmitted],
    ['expired link', () => kSubmitted],
    ['draft claim', () => rDraft],
    ['unknown uuid', () => randomUUID()],
    ['malformed id', () => 'not-a-uuid'],
  ])('%s: same 403 on detail and events; nothing changes', async (_label, idOf) => {
    const id = idOf();
    for (const res of [await get(`/claims/${id}`), await post(`/claims/${id}/events`, { status: 'query', note: 'Need bills' })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
    }
    if (id.length === 36) {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1', [id]);
      expect(rows[0]?.n).toBeLessThanOrEqual(1);
    }
  });

  it('a bad body on an unlinked claim is still 403 (access first)', async () => {
    const res = await post(`/claims/${xSubmitted}/events`, { status: 'submitted', bogus: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN);
  });

  it('a doctor gets 403 on /other/insurance/claims', async () => {
    expect((await get('/claims', doctor)).status).toBe(403);
    expect((await get(`/claims/${rQuery}`, doctor)).status).toBe(403);
    expect((await post(`/claims/${rQuery}/events`, { status: 'query' }, doctor)).status).toBe(403);
  });
});
