import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { decryptField, encryptField, maskField } from '../src/lib/field-crypto.js';
import { verhoeffValid, type Employee } from '../src/modules/payroll/employees.js';

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
// A valid Aadhaar number: 11 digits plus the Verhoeff check digit.
const aadhaarOf = (n: number) => {
  const base = `${2 + (n % 8)}${String(n).padStart(10, '0')}`;
  return base + [...'0123456789'].find((d) => verhoeffValid(base + d));
};
const AADHAAR_NEW = aadhaarOf(41);
const AADHAAR_DUP = aadhaarOf(42);

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
    expect(body.items.find((e) => e.id === sparse)).toMatchObject({ uan: null, esic: null, aadhaar: null });
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

describe('GET /admin/employees/{id}', () => {
  const one = (id: string, who = admin) => app.request(`/admin/employees/${id}`, {}, who);

  it('200 masked, audited with no plaintext', async () => {
    const id = await employee('Detail Test', 'Nurse');
    const res = await one(id);
    const text = await res.text();
    expect(res.status).toBe(200);
    for (const secret of [PAN, UAN, ESIC, ACCOUNT]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ id, name: 'Detail Test', pan: '****234F', bankAccount: { number: '****9012' } });
    const audit = await db.query("SELECT * FROM audit_events WHERE record_type = 'employee' AND record_id = $1", [id]);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const secret of [PAN, UAN, ESIC, ACCOUNT]) expect(JSON.stringify(audit.rows)).not.toContain(secret);
  });

  it('404 for unknown, non-UUID and voided; 403 without payroll.employee', async () => {
    expect((await one('77777777-7777-4777-8777-777777777777')).status).toBe(404);
    expect((await one('nope')).status).toBe(404);
    const id = await employee('Voided One', 'Clerk');
    await db.query('UPDATE employees SET voided_at = now() WHERE id = $1', [id]);
    expect((await one(id)).status).toBe(404);
    const live = await employee('Live One', 'Clerk');
    expect((await one(live, doctor)).status).toBe(403);
  });
});

describe('PATCH /admin/employees/{id}', () => {
  const patch = (id: string, body: unknown, who = admin) =>
    app.request(`/admin/employees/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('updates each field; masked response; audit names sensitive fields, never values', async () => {
    const id = await employee('Patch Me', 'Clerk');
    const { rows: u } = await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-nurse'");
    const userId = String(u[0]?.id);
    const res = await patch(id, {
      version: 1, name: 'Patched', designation: 'Head Clerk', joinDate: '2023-02-03', salaryStructureId: '88888888-8888-4888-8888-888888888888',
      active: false, userId, aadhaar: AADHAAR_NEW, pan: 'ZZZZZ9999Z', uan: '999888777666', esic: '9999888877',
      bankAccount: { name: 'HDFC', number: '55556666777788', ifsc: 'HDFC0009999' }, reason: 'HR correction',
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      version: 2, name: 'Patched', designation: 'Head Clerk', joinDate: '2023-02-03', active: false, userId,
      aadhaar: `****${AADHAAR_NEW.slice(-4)}`, pan: '****999Z', uan: '****7666', esic: '****8877', bankAccount: { name: 'HDFC', number: '****7788', ifsc: 'HDFC0009999' },
    });
    const audit = JSON.stringify((await db.query("SELECT * FROM audit_events WHERE record_type = 'employee' AND record_id = $1 AND action = 'update'", [id])).rows);
    expect(audit).toContain('HR correction');
    for (const secret of [AADHAAR_NEW, 'ZZZZZ9999Z', '999888777666', '9999888877', '55556666777788', '999Z', '7666', '8877', '7788', ...[PAN, UAN, ESIC, ACCOUNT]])
      expect(audit, secret).not.toContain(secret);
    for (const key of ['pan', 'uan', 'esic', 'bankAccount', 'aadhaar']) expect(audit).toContain(key);
    const stored = await db.query('SELECT pan_enc, aadhaar_enc FROM employees WHERE id = $1', [id]);
    expect(await decryptField(String(stored.rows[0]?.pan_enc))).toBe('ZZZZZ9999Z');
    // null detaches the login
    const again = await patch(id, { version: 2, userId: null });
    expect(((await again.json()) as Employee).userId).toBeNull();
  });

  it('null clears pan and bank; aadhaar null is 422; empty change is 422', async () => {
    const id = await employee('Clear Me', 'Clerk');
    const res = await patch(id, { version: 1, pan: null, bankAccount: null, uan: null });
    expect(await res.json()).toMatchObject({ pan: null, bankAccount: null, uan: null, esic: '****3456' });
    expect((await patch(id, { version: 2, aadhaar: null })).status).toBe(422);
    expect((await patch(id, { version: 2 })).status).toBe(422);
    expect((await patch(id, { version: 2, reason: 'x' })).status).toBe(422);
    expect((await patch(id, { version: 2, bogus: 1 })).status).toBe(422);
    expect((await patch(id, { version: 2, pan: 'bad' })).status).toBe(422);
  });

  it('409 duplicate_aadhaar, user_has_employee; 422 user_unknown; same Aadhaar on itself is fine', async () => {
    const a = await employee('Dup A', 'Clerk');
    const b = await employee('Dup B', 'Clerk');
    expect((await patch(a, { version: 1, aadhaar: AADHAAR_DUP })).status).toBe(200);
    const dup = await patch(b, { version: 1, aadhaar: AADHAAR_DUP });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate_aadhaar' });
    expect((await patch(a, { version: 2, aadhaar: AADHAAR_DUP })).status).toBe(200);
    const { rows } = await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-reception'");
    const userId = String(rows[0]?.id);
    expect((await patch(a, { version: 3, userId })).status).toBe(200);
    const taken = await patch(b, { version: 1, userId });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: 'user_has_employee' });
    expect((await patch(a, { version: 4, userId })).status).toBe(200);
    expect((await patch(b, { version: 1, userId: '77777777-7777-4777-8777-777777777777' })).status).toBe(422);
  });

  it('409 stale version, 404, 403', async () => {
    const id = await employee('Stale', 'Clerk');
    expect((await patch(id, { version: 1, name: 'One' })).status).toBe(200);
    const stale = await patch(id, { version: 1, name: 'Two' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict' });
    expect((await patch('77777777-7777-4777-8777-777777777777', { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch('nope', { version: 1, name: 'X' })).status).toBe(404);
    const gone = await employee('Gone', 'Clerk');
    await db.query('UPDATE employees SET voided_at = now() WHERE id = $1', [gone]);
    expect((await patch(gone, { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch(id, { version: 2, name: 'Three' }, doctor)).status).toBe(403);
  });
});

describe('POST /admin/employees', () => {
  const SS = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
  const body = (over: Record<string, unknown> = {}) => ({
    aadhaar: aadhaarOf(1),
    name: ' Post Person ',
    designation: 'Clerk',
    joinDate: '2025-05-01',
    pan: ' abcde 1234f ',
    uan: '1002 0030 0400',
    esic: '3100123456',
    bankAccount: { name: 'HDFC', number: '5020 0012 3456 78', ifsc: ' hdfc0001234 ' },
    salaryStructureId: SS,
    ...over,
  });
  const post = (b: unknown, who = admin) =>
    app.request('/admin/employees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, who);

  it('201 masked; the row holds ciphertext of the normalized values; audit has no plaintext', async () => {
    const res = await post(body());
    const text = await res.text();
    expect(res.status).toBe(201);
    const e = JSON.parse(text) as Employee;
    expect(e).toMatchObject({
      version: 1, userId: null, name: 'Post Person', designation: 'Clerk', joinDate: '2025-05-01', pan: '****234F', uan: '****0400',
      esic: '****3456', bankAccount: { name: 'HDFC', number: '****5678', ifsc: 'HDFC0001234' }, salaryStructureId: SS, active: true,
    });
    expect(e.aadhaar).toBe(`****${aadhaarOf(1).slice(-4)}`);
    for (const s of ['ABCDE1234F', '100200300400', '50200012345678', aadhaarOf(1)]) expect(text).not.toContain(s);
    const { rows } = await db.query('SELECT * FROM employees WHERE id = $1', [e.id]);
    const row = rows[0] as Record<string, string>;
    expect(await decryptField(row.aadhaar_enc as string)).toBe(aadhaarOf(1));
    expect(JSON.stringify(row)).not.toContain(aadhaarOf(1));
    expect(JSON.stringify(row)).not.toContain('ABCDE1234F');
    expect(await decryptField(row.pan_enc as string)).toBe('ABCDE1234F');
    expect(await decryptField(row.uan_enc as string)).toBe('100200300400');
    expect(await decryptField(row.esic_enc as string)).toBe('3100123456');
    expect(JSON.parse(await decryptField(row.bank_enc as string))).toEqual({ name: 'HDFC', number: '50200012345678', ifsc: 'HDFC0001234' });
    const audit = await db.query("SELECT * FROM audit_events WHERE record_type = 'employee' AND record_id = $1", [e.id]);
    expect(audit.rows).toHaveLength(1);
    const stored = JSON.stringify(audit.rows);
    for (const s of [aadhaarOf(1), aadhaarOf(1).slice(-4), 'ABCDE1234F', '1234F', '100200300400', '3100123456', '50200012345678', '45678', 'HDFC0001234']) expect(stored).not.toContain(s);
    expect(stored).toContain('Post Person');
  });

  it('only aadhaar, name, designation, joinDate and salaryStructureId are required', async () => {
    const { uan: _u, esic: _e, pan: _p, bankAccount: _b, ...rest } = body({ name: 'Sparse Post', aadhaar: aadhaarOf(2) });
    const res = await post(rest);
    expect(res.status).toBe(201);
    const e = (await res.json()) as Employee;
    expect(e).toMatchObject({ pan: null, uan: null, esic: null, bankAccount: null, aadhaar: `****${aadhaarOf(2).slice(-4)}` });
    const list = (await get('?q=sparse post')).body.items.find((x) => x.id === e.id);
    expect(list).toMatchObject({ pan: null, bankAccount: null });
  });

  it('accepts an Aadhaar number with spaces or hyphens', async () => {
    const a = aadhaarOf(3);
    const res = await post(body({ name: 'Spaced Aadhaar', aadhaar: `${a.slice(0, 4)} ${a.slice(4, 8)}-${a.slice(8)}` }));
    expect(res.status).toBe(201);
  });

  it('422 when aadhaar is missing, malformed or fails the checksum', async () => {
    const { aadhaar: _a, ...noAadhaar } = body();
    expect((await post(noAadhaar)).status).toBe(422);
    const good = aadhaarOf(4);
    const wrongLast = good.slice(0, 11) + ((Number(good[11]) + 1) % 10);
    for (const aadhaar of [wrongLast, '123456789012', '0' + good.slice(1), good.slice(0, 11), good + '1', 'abcdefghijkl'])
      expect((await post(body({ aadhaar }))).status, aadhaar).toBe(422);
  });

  it('409 duplicate_aadhaar, even when written with spaces', async () => {
    expect((await post(body({ name: 'Dup One', aadhaar: aadhaarOf(5) }))).status).toBe(201);
    const a = aadhaarOf(5);
    const dup = await post(body({ name: 'Dup Two', aadhaar: `${a.slice(0, 4)} ${a.slice(4)}` }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate_aadhaar' });
  });

  it('403, and 422 for each bad format or extra field', async () => {
    expect((await post(body(), doctor)).status).toBe(403);
    const bad: Record<string, unknown>[] = [
      { pan: 'ABCDE12345' }, { pan: 'ABCD1234F' }, { uan: '12345' }, { esic: '12345678901' }, { esic: 'abc' },
      { bankAccount: { name: 'B', number: '12345678', ifsc: 'HDFC0001234' } },
      { bankAccount: { name: 'B', number: '123456789', ifsc: 'HDFC1001234' } },
      { bankAccount: { name: 'B', number: '123456789', ifsc: 'HDFC0001234', extra: 1 } },
      { name: '  ' }, { designation: 'x'.repeat(101) }, { joinDate: '2025-02-30' }, { joinDate: '01-05-2025' },
      { salaryStructureId: 'nope' }, { userId: 'nope' }, { active: false },
    ];
    for (const over of bad) expect((await post(body(over))).status, JSON.stringify(over)).toBe(422);
    expect((await post(undefined)).status).toBe(422);
  });

  it('user_unknown 422 and user_has_employee 409', async () => {
    const unknown = await post(body({ aadhaar: aadhaarOf(8), userId: '77777777-7777-4777-8777-777777777777' }));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ error: 'user_unknown' });
    const { rows } = await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-doctor'");
    const userId = String(rows[0]?.id);
    const ok = await post(body({ name: 'Linked Post', userId, aadhaar: aadhaarOf(6) }));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Employee).userId).toBe(userId);
    const dup = await post(body({ name: 'Linked Twice', userId, aadhaar: aadhaarOf(7) }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'user_has_employee' });
  });
});
