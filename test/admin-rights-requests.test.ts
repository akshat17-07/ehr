import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const kavita = seedId('9a710000', 4);

async function request(createdAt: string, o: { kind?: string; status?: string; voided?: boolean; respondedBy?: string } = {}) {
  const closed = o.status === 'closed';
  const { rows } = await db.query(
    `INSERT INTO rights_requests (id, status, created_by, updated_by, created_at, updated_at, voided_at, patient_id, kind, text, requested_by, response, outcome, responded_at, responded_by)
     VALUES (gen_random_uuid(), $2, 'p', 'p', $1, $1, $3, $4, $5, 'Please help', 'portal-sub', $6, $7, $8, $9) RETURNING id`,
    [
      createdAt, o.status ?? 'open', o.voided ? createdAt : null, kavita, o.kind ?? 'access',
      closed ? 'Done it' : null, closed ? 'done' : null, closed ? createdAt : null, closed ? (o.respondedBy ?? 'dev-admin') : null,
    ],
  );
  return String(rows[0]?.id);
}

type Item = { id: string; kind: string; status: string; patientId: string; uhid: string; patientName: string; dueBy: string; response: string | null; respondedBy: string | null; outcome: string | null };
const get = (q = '', who = admin) => app.request(`/admin/rights-requests${q}`, {}, who);

describe('GET /admin/rights-requests', () => {
  it('lists oldest first with patient, dueBy 90 days later, responder as users.id; pages; filters', async () => {
    const a = await request('2033-01-01T00:00:00Z', { kind: 'access' });
    const b = await request('2033-01-02T00:00:00Z', { kind: 'grievance', status: 'closed' });
    const c = await request('2033-01-03T00:00:00Z', { kind: 'correction' });
    await request('2033-01-04T00:00:00Z', { voided: true });

    const all = (await (await get('?limit=100')).json()) as { items: Item[] };
    const mine = all.items.filter((i) => [a, b, c].includes(i.id));
    expect(mine.map((i) => i.id)).toEqual([a, b, c]);
    expect(mine[0]).toMatchObject({ patientId: kavita, kind: 'access', status: 'open', response: null, respondedBy: null, outcome: null });
    expect(mine[0]?.uhid).toBeTruthy();
    expect(mine[0]?.patientName).toBeTruthy();
    expect(mine[0]?.dueBy).toBe('2033-04-01T00:00:00.000Z');
    expect(mine[1]).toMatchObject({ status: 'closed', response: 'Done it', outcome: 'done', respondedBy: seedId('a0000000', 1) });
    expect(all.items.some((i) => i.dueBy === '2033-04-04T00:00:00.000Z')).toBe(false); // voided

    const closed = (await (await get('?status=closed&limit=100')).json()) as { items: Item[] };
    expect(closed.items.every((i) => i.status === 'closed')).toBe(true);
    expect(closed.items.map((i) => i.id)).toContain(b);
    const open = (await (await get('?status=open&kind=correction&limit=100')).json()) as { items: Item[] };
    expect(open.items.map((i) => i.id)).toContain(c);
    expect(open.items.every((i) => i.status === 'open' && i.kind === 'correction')).toBe(true);

    const seen: string[] = [];
    let cursor = '';
    for (;;) {
      const page = (await (await get(`?limit=2${cursor}`)).json()) as { items: Item[]; nextCursor?: string };
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = `&cursor=${page.nextCursor}`;
    }
    expect(seen.filter((id) => [a, b, c].includes(id))).toEqual([a, b, c]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('falls back to the stored sub when no user has it', async () => {
    const id = await request('2033-02-01T00:00:00Z', { status: 'closed', respondedBy: 'unknown-sub' });
    const all = (await (await get('?limit=100')).json()) as { items: Item[] };
    expect(all.items.find((i) => i.id === id)?.respondedBy).toBe('unknown-sub');
  });

  it('audits the read', async () => {
    await get();
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'rights_request'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('403 for a doctor; 422 for a bad enum, limit or extra query', async () => {
    expect((await get('', doctor)).status).toBe(403);
    for (const q of ['?status=pending', '?kind=other', '?limit=0', '?limit=101', '?x=1', '?cursor=zzz']) expect((await get(q)).status, q).toBe(422);
  });
});

describe('POST /admin/rights-requests/:id/respond', () => {
  const respond = (id: string, body: unknown, who = admin) =>
    app.request(`/admin/rights-requests/${id}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('closes an open request (done) and returns the list shape', async () => {
    const id = await request('2034-01-01T00:00:00Z');
    const res = await respond(id, { response: 'Copy sent', outcome: 'done' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id, status: 'closed', response: 'Copy sent', outcome: 'done', outcomeReason: null, version: 2,
      respondedBy: seedId('a0000000', 1), patientId: kavita, dueBy: '2034-04-01T00:00:00.000Z',
    });
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'rights_request' AND record_id = $1", [id]);
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('422 when partly_done or refused has no reason; refused with a reason is ok', async () => {
    const id = await request('2034-01-02T00:00:00Z');
    expect((await respond(id, { response: 'x', outcome: 'partly_done' })).status).toBe(422);
    expect((await respond(id, { response: 'x', outcome: 'refused', reason: '  ' })).status).toBe(422);
    expect((await respond(id, { response: '', outcome: 'done' })).status).toBe(422);
    const ok = await respond(id, { response: 'No', outcome: 'refused', reason: 'Record is required by law' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ outcome: 'refused', outcomeReason: 'Record is required by law', status: 'closed' });
  });

  it('409 when already closed; 404 unknown id; 403 without compliance.rights', async () => {
    const id = await request('2034-01-03T00:00:00Z');
    expect((await respond(id, { response: 'x', outcome: 'done' }, doctor)).status).toBe(403);
    expect((await respond(id, { response: 'x', outcome: 'done' })).status).toBe(200);
    expect((await respond(id, { response: 'again', outcome: 'done' })).status).toBe(409);
    expect((await respond(seedId('9a710000', 99), { response: 'x', outcome: 'done' })).status).toBe(404);
    expect((await respond('nope', { response: 'x', outcome: 'done' })).status).toBe(404);
  });
});
