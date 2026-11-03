import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { decryptField, encryptField, maskField } from '../src/lib/field-crypto.js';
import type { Employee } from '../src/modules/payroll/employees.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);

async function get(query = '', who = admin) {
  const res = await app.request(`/admin/employees${query}`, {}, who);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { items: Employee[]; nextCursor?: string } };
}

const PAN = 'ABCDE1234F';
const UAN = '100200300400';
const ESIC = '3100123456';
const ACCOUNT = '000123456789012';

async function employee(name: string, designation: string, opts: { active?: boolean; userId?: string | null; full?: boolean } = {}) {
  const bank = await encryptField(JSON.stringify({ name: 'State Bank', number: ACCOUNT, ifsc: 'SBIN0001234' }));
  const { rows } = await db.query(
    `INSERT INTO employees (id, status, created_by, updated_by, created_at, updated_at, user_id, name, designation, join_date, pan_enc, uan_enc, esic_enc, bank_enc, salary_structure_id, active)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $1, $2, $3, '2024-04-01', $4, $5, $6, $7, 's-1', $8) RETURNING id`,
    [opts.userId ?? null, name, designation, await encryptField(PAN), opts.full === false ? null : await encryptField(UAN), opts.full === false ? null : await encryptField(ESIC), bank, opts.active ?? true],
  );
  return String(rows[0]?.id);
}

describe('field crypto', () => {
  it('round-trips, with a fresh ciphertext each time', async () => {
    const a = await encryptField(PAN);
    const b = await encryptField(PAN);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toContain(PAN);
    expect(await decryptField(a)).toBe(PAN);
    expect(await decryptField(await encryptField(''))).toBe('');
    expect(maskField(PAN)).toBe('****234F');
  });

  it('throws on a changed or badly formatted value', async () => {
    const parts = (await encryptField(PAN)).split(':');
    const data = Buffer.from(parts[3] as string, 'base64');
    data[0] = (data[0] ?? 0) ^ 1;
    await expect(decryptField([parts[0], parts[1], parts[2], data.toString('base64')].join(':'))).rejects.toThrow();
    await expect(decryptField([parts[0], parts[1], Buffer.alloc(16).toString('base64'), parts[3]].join(':'))).rejects.toThrow();
    await expect(decryptField('v2:a:b:c')).rejects.toThrow();
    await expect(decryptField('plain')).rejects.toThrow();
  });
});

describe('GET /admin/employees', () => {
  it('403 without payroll.employee, 422 on bad query', async () => {
    expect((await get('', doctor)).status).toBe(403);
    expect((await get('?bogus=1')).status).toBe(422);
    expect((await get('?active=maybe')).status).toBe(422);
    expect((await get('?limit=0')).status).toBe(422);
    expect((await get(`?q=${'x'.repeat(101)}`)).status).toBe(422);
  });

  it('masks PAN, UAN, ESIC and the account number; no plaintext in the response or audit row', async () => {
    const id = await employee('Mask Test', 'Accountant');
    const sparse = await employee('Mask Sparse', 'Cleaner', { full: false });
    const { status, text, body } = await get('?q=mask');
    expect(status).toBe(200);
    for (const secret of [PAN, UAN, ESIC, ACCOUNT]) expect(text).not.toContain(secret);
    const full = body.items.find((e) => e.id === id);
    expect(full).toMatchObject({
      version: 1,
      userId: null,
      name: 'Mask Test',
      designation: 'Accountant',
      joinDate: '2024-04-01',
      pan: '****234F',
      uan: '****0400',
      esic: '****3456',
      bankAccount: { name: 'State Bank', number: '****9012', ifsc: 'SBIN0001234' },
      salaryStructureId: 's-1',
      active: true,
    });
    expect(body.items.find((e) => e.id === sparse)).toMatchObject({ uan: null, esic: null });
    const { rows } = await db.query("SELECT * FROM audit_events WHERE record_type = 'employee' AND path LIKE '%/admin/employees%'").catch(() => ({ rows: [] }));
    for (const secret of [PAN, UAN, ESIC, ACCOUNT]) expect(JSON.stringify(rows)).not.toContain(secret);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'employee' AND action = 'view'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('shows the users.id of a linked login', async () => {
    const { rows } = await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-admin'");
    const id = await employee('Linked Person', 'Admin officer', { userId: 'dev-admin' });
    const found = (await get('?q=linked person')).body.items.find((e) => e.id === id);
    expect(found?.userId).toBe(String(rows[0]?.id));
  });

  it('filters by active and by q (name or designation, any case)', async () => {
    await employee('Filter Alpha', 'Pharmacist');
    await employee('Filter Beta', 'Lab Technician', { active: false });
    const names = (r: { body: { items: Employee[] } }) => r.body.items.map((e) => e.name);
    expect(names(await get('?q=FILTER'))).toEqual(['Filter Alpha', 'Filter Beta']);
    expect(names(await get('?q=filter&active=false'))).toEqual(['Filter Beta']);
    expect(names(await get('?q=filter&active=true'))).toEqual(['Filter Alpha']);
    expect(names(await get('?q=technician'))).toEqual(['Filter Beta']);
    expect(names(await get('?q=zzzz-none'))).toEqual([]);
  });

  it('pages by name with a cursor', async () => {
    for (const n of ['Page A', 'Page B', 'Page C', 'Page D', 'Page E']) await employee(n, 'Pager');
    const first = await get('?q=pager&limit=2');
    expect(first.body.items.map((e) => e.name)).toEqual(['Page A', 'Page B']);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await get(`?q=pager&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e) => e.name)).toEqual(['Page C', 'Page D']);
    const third = await get(`?q=pager&limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((e) => e.name)).toEqual(['Page E']);
    expect(third.body.nextCursor).toBeUndefined();
  });
});
