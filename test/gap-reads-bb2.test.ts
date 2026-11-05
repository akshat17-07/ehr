import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// Tasks 702 (patient agent links), 703 (salary structure by id, advances list), 710 (indent reads).

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const nurse = asStaff('dev-nurse', ['nurse']);
const medical = asStaff('dev-medical', ['medical']);
const reception = asStaff('dev-reception', ['staff']);
const get = async (path: string, who = admin) => {
  const res = await app.request(path, {}, who);
  return { status: res.status, body: (await res.json()) as never };
};
const post = (path: string, body: unknown, who = admin) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);

const patient = seedId('9a710000', 1);
const hivPatient = seedId('9a710000', 2);
await db.query(`UPDATE patients SET labels = '["hiv"]' WHERE id = $1`, [hivPatient]);
const agentId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-insurance'")).rows[0]?.id);

async function link(patientId: string, from: string, to: string | null, at: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_links (id, status, created_at, created_by, updated_by, patient_id, agent_user_id, from_date, to_date)
     VALUES ($1, 'active', $2, 'test', 'test', $3, $4, $5, $6)`,
    [id, at, patientId, agentId, from, to],
  );
  return id;
}

describe('#702 GET /staff/patients/{id}/agent-links', () => {
  it('newest first, ended links included, ?active=true filters; ids work with the end endpoint', async () => {
    const ended = await link(patient, '2020-01-01', '2020-12-31', '2026-01-01T00:00:00Z');
    const open = await link(patient, '2026-01-01', null, '2026-02-01T00:00:00Z');
    const { status, body } = await get(`/staff/patients/${patient}/agent-links`);
    expect(status).toBe(200);
    const items = body as { id: string; agentId: string; agentName: string; fromDate: string; toDate: string | null; version: number }[];
    expect(items.map((i) => i.id)).toEqual([open, ended]);
    expect(items[0]).toMatchObject({ agentId, fromDate: '2026-01-01', toDate: null, version: 1 });
    expect(items[0]!.agentName).toBeTruthy();
    const active = (await get(`/staff/patients/${patient}/agent-links?active=true`)).body as { id: string }[];
    expect(active.map((i) => i.id)).toEqual([open]);
    const res = await post(`/staff/agent-links/${open}/end`, {});
    expect(res.status).not.toBe(404);
  });

  it('403 without the permission, 403 for a sensitive patient, 404 unknown, 422 bad filter', async () => {
    expect((await get(`/staff/patients/${patient}/agent-links`, nurse)).status).toBe(403);
    expect((await get(`/staff/patients/${hivPatient}/agent-links`)).status).toBe(403);
    expect((await get(`/staff/patients/${randomUUID()}/agent-links`)).status).toBe(404);
    expect((await get(`/staff/patients/${patient}/agent-links?active=maybe`)).status).toBe(422);
  });
});

async function structure(name: string) {
  const { rows } = await db.query(
    `INSERT INTO salary_structures (id, status, created_by, updated_by, created_at, updated_at, name, basic_paise, hra_paise, allowances, epf, esi, professional_tax)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $1, 3000000, 1200000, '[]', true, false, true) RETURNING id`,
    [name],
  );
  return String(rows[0]?.id);
}
async function employee(name: string) {
  const { rows } = await db.query(
    `INSERT INTO employees (id, status, created_by, updated_by, created_at, updated_at, name, designation, join_date, salary_structure_id, active)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $1, 'Clerk', '2024-04-01', 's-1', true) RETURNING id`,
    [name],
  );
  return String(rows[0]?.id);
}
async function advance(employeeId: string, amount: number, recovered: number, at: string) {
  const { rows } = await db.query(
    `INSERT INTO advances (id, status, created_by, updated_by, created_at, employee_id, amount_paise, given_on, recover_per_month_paise, recovered_paise)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', $1, $2, $3, '2026-03-01', 100000, $4) RETURNING id`,
    [at, employeeId, amount, recovered],
  );
  return String(rows[0]?.id);
}

describe('#703 GET /admin/salary-structures/{id}', () => {
  it('one structure with version', async () => {
    const id = await structure('Grade One');
    const { status, body } = await get(`/admin/salary-structures/${id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, name: 'Grade One', basicPaise: 3000000, hraPaise: 1200000, version: 1 });
  });
  it('403 and 404', async () => {
    const id = await structure('Grade Two');
    expect((await get(`/admin/salary-structures/${id}`, nurse)).status).toBe(403);
    expect((await get(`/admin/salary-structures/${randomUUID()}`)).status).toBe(404);
    expect((await get('/admin/salary-structures/not-a-uuid')).status).toBe(404);
  });
});

describe('#703 GET /admin/payroll/advances', () => {
  it('lists newest first with paise, balance, status; filters by employee and status; pages', async () => {
    const e1 = await employee('Adv One');
    const e2 = await employee('Adv Two');
    const open = await advance(e1, 500000, 100000, '2026-04-01T00:00:00Z');
    const closed = await advance(e1, 200000, 200000, '2026-04-02T00:00:00Z');
    const other = await advance(e2, 300000, 0, '2026-04-03T00:00:00Z');
    type A = { id: string; amountPaise: number; balancePaise: number; status: string; version: number };
    const all = (await get(`/admin/payroll/advances?employeeId=${e1}`)).body as { items: A[] };
    expect(all.items.map((a) => a.id)).toEqual([closed, open]);
    expect(all.items[1]).toMatchObject({ amountPaise: 500000, recoverPerMonthPaise: 100000, recoveredPaise: 100000, balancePaise: 400000, status: 'open', version: 1 });
    expect(all.items[0]).toMatchObject({ balancePaise: 0, status: 'closed' });
    const o = (await get(`/admin/payroll/advances?employeeId=${e1}&status=open`)).body as { items: A[] };
    expect(o.items.map((a) => a.id)).toEqual([open]);
    const c = (await get('/admin/payroll/advances?status=closed')).body as { items: A[] };
    expect(c.items.map((a) => a.id)).toContain(closed);
    expect(c.items.map((a) => a.id)).not.toContain(other);
    const p1 = (await get('/admin/payroll/advances?limit=1')).body as { items: A[]; nextCursor?: string };
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await get(`/admin/payroll/advances?limit=1&cursor=${p1.nextCursor}`)).body as { items: A[] };
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
  });
  it('403 and 422', async () => {
    expect((await get('/admin/payroll/advances', nurse)).status).toBe(403);
    expect((await get('/admin/payroll/advances?status=weird')).status).toBe(422);
  });
});

async function indent(patientId: string | null, status = 'requested') {
  const id = randomUUID();
  await db.query(`INSERT INTO indents (id, status, created_by, updated_by, ward, patient_id, lines) VALUES ($1, $2, 'x', 'x', 'Ward A', $3, $4)`, [
    id,
    status,
    patientId,
    JSON.stringify([{ itemId: seedId('d0000000', 1), qty: 3 }]),
  ]);
  return id;
}

describe('#710 stock indent reads', () => {
  it('lists with status and patient filters; detail has lines', async () => {
    const ward = await indent(null);
    const mine = await indent(patient);
    const issued = await indent(patient, 'issued');
    const all = (await get('/staff/stock/indents', medical)).body as { items: { id: string }[] };
    expect(all.items.map((i) => i.id)).toEqual(expect.arrayContaining([ward, mine, issued]));
    const byStatus = (await get('/staff/stock/indents?status=issued', medical)).body as { items: { status: string }[] };
    expect(byStatus.items.every((i) => i.status === 'issued')).toBe(true);
    const byPatient = (await get(`/staff/stock/indents?patientId=${patient}`, medical)).body as { items: { id: string }[] };
    expect(byPatient.items.map((i) => i.id).sort()).toEqual([mine, issued].sort());
    const one = await get(`/staff/stock/indents/${mine}`, medical);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: mine, ward: 'Ward A', patientId: patient, version: 1, lines: [{ itemId: seedId('d0000000', 1), qty: 3 }] });
  });
  it('patient access: 403 on the filter and on detail; unfiltered list hides the indent', async () => {
    const secret = await indent(hivPatient);
    expect((await get(`/staff/stock/indents?patientId=${hivPatient}`, medical)).status).toBe(403);
    expect((await get(`/staff/stock/indents/${secret}`, medical)).status).toBe(403);
    const all = (await get('/staff/stock/indents?limit=100', medical)).body as { items: { id: string }[] };
    expect(all.items.map((i) => i.id)).not.toContain(secret);
  });
  it('404, 403 without stock.view, 422 bad filter', async () => {
    expect((await get(`/staff/stock/indents/${randomUUID()}`, medical)).status).toBe(404);
    expect((await get('/staff/stock/indents/nope', medical)).status).toBe(404);
    expect((await get('/staff/stock/indents', reception)).status).toBe(403);
    expect((await get('/staff/stock/indents?status=x', medical)).status).toBe(422);
  });
});
