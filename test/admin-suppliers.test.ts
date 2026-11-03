import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const send = (method: string, path: string, body?: unknown, who = admin) =>
  app.request(path, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, who);

interface Supplier { id: string; version: number; name: string; gstin?: string; phone?: string; email?: string; address?: Record<string, string>; active: boolean }
const address = { line1: '1 Market Rd', city: 'Bhopal', district: 'Bhopal', state: 'Madhya Pradesh', pincode: '462001' };
const GSTIN = '23ABCDE1234F1Z5';

describe('#293 POST /admin/suppliers', () => {
  it('adds a supplier, audits, rejects a duplicate name and bad input', async () => {
    const res = await send('POST', '/admin/suppliers', { name: 'Zzmed Distributors', gstin: GSTIN.toLowerCase(), phone: '+91 98765 43210', email: 'a@zz.in', address });
    expect(res.status).toBe(201);
    const s = (await res.json()) as Supplier;
    expect(s).toMatchObject({ name: 'Zzmed Distributors', version: 1, active: true, gstin: GSTIN, address });
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'supplier' AND record_id = $1", [s.id]);
    expect(audit.rows.length).toBe(1);

    expect((await send('POST', '/admin/suppliers', { name: 'zzmed distributors' })).status).toBe(409);
    expect((await send('POST', '/admin/suppliers', { name: 'Zzmed Two' }, doctor)).status).toBe(403);
    for (const body of [{}, { name: 'x', gstin: '123' }, { name: 'x', email: 'nope' }, { name: 'x', phone: 'abc' }, { name: 'x', address: { line1: 'a' } }, { name: 'x', extra: 1 }]) {
      expect((await send('POST', '/admin/suppliers', body)).status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('#292 GET /admin/suppliers', () => {
  it('lists A to Z with q and active filters', async () => {
    await send('POST', '/admin/suppliers', { name: 'Zzalpha Pharma', drugLicenceNo: 'MP-DL-77' });
    const all = (await (await send('GET', '/admin/suppliers?q=zz')).json()) as Supplier[];
    expect(all.map((s) => s.name)).toEqual(['Zzalpha Pharma', 'Zzmed Distributors']);
    expect(((await (await send('GET', '/admin/suppliers?q=mp-dl-77')).json()) as Supplier[]).map((s) => s.name)).toEqual(['Zzalpha Pharma']);
    const alpha = all[0]!;
    expect((await send('PATCH', `/admin/suppliers/${alpha.id}`, { version: 1, active: false })).status).toBe(200);
    expect(((await (await send('GET', '/admin/suppliers?q=zz&active=true')).json()) as Supplier[]).map((s) => s.name)).toEqual(['Zzmed Distributors']);
    expect(((await (await send('GET', '/admin/suppliers?q=zz&active=false')).json()) as Supplier[]).map((s) => s.name)).toEqual(['Zzalpha Pharma']);
    expect((await send('GET', '/admin/suppliers', undefined, doctor)).status).toBe(403);
    expect((await send('GET', '/admin/suppliers?active=maybe')).status).toBe(422);
  });
});

describe('#294 PATCH /admin/suppliers/{id}', () => {
  it('edits with version and reason, keeps history, audits changes', async () => {
    const s = (await (await send('POST', '/admin/suppliers', { name: 'Zzedit Co', phone: '0755 1234567' })).json()) as Supplier;
    const res = await send('PATCH', `/admin/suppliers/${s.id}`, { version: 1, name: 'Zzedit Company', phone: null, email: 'b@zz.in', reason: 'renamed' });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Supplier;
    expect(after).toMatchObject({ version: 2, name: 'Zzedit Company', email: 'b@zz.in' });
    expect(after.phone).toBeUndefined();
    expect((await db.query('SELECT 1 FROM suppliers_versions WHERE record_id = $1', [s.id])).rows.length).toBe(1);
    const audit = await db.query("SELECT changes FROM audit_events WHERE record_type = 'supplier' AND record_id = $1 ORDER BY seq", [s.id]);
    expect(JSON.parse(String(audit.rows[1]?.changes))).toMatchObject({ name: ['Zzedit Co', 'Zzedit Company'], phone: ['0755 1234567', null] });
  });

  it('404, 403, 409 stale version or taken name, 422 nothing to change or bad input', async () => {
    const s = (await (await send('POST', '/admin/suppliers', { name: 'Zzstale Co' })).json()) as Supplier;
    const url = `/admin/suppliers/${s.id}`;
    expect((await send('PATCH', `/admin/suppliers/${randomUUID()}`, { version: 1, active: false })).status).toBe(404);
    expect((await send('PATCH', '/admin/suppliers/nope', { version: 1, active: false })).status).toBe(404);
    expect((await send('PATCH', url, { version: 1, active: false }, doctor)).status).toBe(403);
    expect((await send('PATCH', url, { version: 1, name: 'Zzmed Distributors' })).status).toBe(409);
    expect((await send('PATCH', url, { version: 1, active: true })).status).toBe(422);
    expect((await send('PATCH', url, { version: 1 })).status).toBe(422);
    expect((await send('PATCH', url, { version: 1, gstin: 'bad' })).status).toBe(422);
    expect((await send('PATCH', url, { active: false })).status).toBe(422);
    expect((await send('PATCH', url, { version: 1, active: false })).status).toBe(200);
    expect((await send('PATCH', url, { version: 1, active: true })).status).toBe(409);
  });
});
