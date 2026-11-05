import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// Tasks 701 (GET /staff/doctors) and 706 (single-item reads of drugs, inventory items, suppliers).

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const nurse = asStaff('dev-nurse', ['nurse']);
const medical = asStaff('dev-medical', ['medical']);
const get = async (path: string, who = nurse) => {
  const res = await app.request(path, {}, who);
  return { status: res.status, body: (await res.json()) as never };
};
const post = (path: string, body: unknown, who = admin) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);

interface Doctor { id: string; name: string; departmentId: string | null; registrationNo: string | null }
interface Page { items: Doctor[]; nextCursor?: string }
const MED = seedId('de000000', 1);

describe('#701 GET /staff/doctors', () => {
  it('lists active doctors and head doctors with only picker fields; id is users.id', async () => {
    const { status, body } = await get('/staff/doctors');
    expect(status).toBe(200);
    const page = body as Page;
    expect(page.items.map((d) => d.name)).toEqual(['Dr Neha Gupta', 'Dr Rakesh Sharma', 'Dr Vikram Singh']);
    const neha = page.items[0]!;
    expect(neha).toEqual({ id: seedId('a0000000', 3), name: 'Dr Neha Gupta', departmentId: MED, registrationNo: expect.stringMatching(/^MP-/) });
    expect(page.items[1]!.registrationNo).toBeNull();
    expect(Object.keys(neha).sort()).toEqual(['departmentId', 'id', 'name', 'registrationNo']);
  });

  it('filters by q (case-insensitive, anywhere in the name) and by department', async () => {
    expect(((await get('/staff/doctors?q=VIKRAM')).body as Page).items.map((d) => d.name)).toEqual(['Dr Vikram Singh']);
    expect(((await get('/staff/doctors?q=gupta')).body as Page).items.map((d) => d.name)).toEqual(['Dr Neha Gupta']);
    expect(((await get('/staff/doctors?q=nobody')).body as Page).items).toEqual([]);
    const med = (await get(`/staff/doctors?departmentId=${MED}`)).body as Page;
    expect(med.items.map((d) => d.name)).toEqual(['Dr Neha Gupta', 'Dr Rakesh Sharma']);
    expect(med.items.every((d) => d.departmentId === MED)).toBe(true);
    const none = (await get(`/staff/doctors?departmentId=${randomUUID()}`)).body as Page;
    expect(none.items).toEqual([]);
  });

  it('pages, hides inactive doctors, rejects bad input and non-workforce groups', async () => {
    const first = (await get('/staff/doctors?limit=2')).body as Page;
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await get(`/staff/doctors?limit=2&cursor=${first.nextCursor}`)).body as Page;
    expect(second.items.map((d) => d.name)).toEqual(['Dr Vikram Singh']);

    await db.query('UPDATE users SET active = false WHERE id = $1', [seedId('a0000000', 4)]);
    expect(((await get('/staff/doctors')).body as Page).items.map((d) => d.name)).not.toContain('Dr Vikram Singh');

    expect((await get('/staff/doctors?departmentId=nope')).status).toBe(422);
    expect((await get(`/staff/doctors?q=${'a'.repeat(101)}`)).status).toBe(422);
    expect((await get('/staff/doctors', asStaff('dev-insurance', ['insurance']))).status).toBe(403);
  });
});

describe('#706 GET /staff/drugs/{id}', () => {
  it('returns one drug like a search row, any staff; 404 for unknown or malformed ids', async () => {
    const id = String((await db.query("SELECT id FROM drugs WHERE name = 'Paracetamol'")).rows[0]!.id);
    const one = await get(`/staff/drugs/${id}`);
    expect(one.status).toBe(200);
    const search = ((await get('/staff/drugs?q=paracetamol')).body as { id: string }[]).find((d) => d.id === id);
    expect(one.body).toEqual(search);
    expect(one.body).toMatchObject({ id, name: 'Paracetamol', version: expect.any(Number), active: true });
    expect(one.body).toHaveProperty('ceilingPaise');
    // an inactive drug can still be read (old movements show its name)
    await db.query('UPDATE drugs SET active = false WHERE id = $1', [id]);
    expect(((await get(`/staff/drugs/${id}`)).body as { active: boolean }).active).toBe(false);
    expect((await get(`/staff/drugs/${randomUUID()}`)).status).toBe(404);
    expect((await get('/staff/drugs/not-a-uuid')).status).toBe(404);
    expect((await get(`/staff/drugs/${id}`, asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('#706 GET /admin/inventory/items/{id}', () => {
  it('returns the admin list row with version; 403 without inventory.manage; 404', async () => {
    const drug = String((await db.query("SELECT id FROM drugs WHERE name = 'Cefixime'")).rows[0]!.id);
    const list = (await get('/admin/inventory/items?q=cefixime', admin)).body as { items: { id: string }[] };
    const fromList = list.items.find((i) => i.id === drug);
    expect(fromList).toBeTruthy();
    const one = await get(`/admin/inventory/items/${drug}`, admin);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(fromList);
    expect(one.body).toMatchObject({ id: drug, version: expect.any(Number), kind: 'drug' });

    expect((await get(`/admin/inventory/items/${drug}`, nurse)).status).toBe(403);
    expect((await get(`/admin/inventory/items/${randomUUID()}`, admin)).status).toBe(404);
    expect((await get('/admin/inventory/items/xyz', admin)).status).toBe(404);
  });

  it('also reads a non-drug item', async () => {
    const created = await post('/staff/inventory/items', { name: 'Zzgauze Roll', kind: 'consumable', unit: 'roll' }, medical);
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string };
    const one = await get(`/admin/inventory/items/${item.id}`, admin);
    expect(one.body).toMatchObject({ id: item.id, name: 'Zzgauze Roll', kind: 'consumable', version: 1 });
  });
});

describe('#706 GET /admin/suppliers/{id}', () => {
  it('returns the supplier with version; 403; 404', async () => {
    const made = (await (await post('/admin/suppliers', { name: 'Zzone Pharma', gstin: '23ABCDE1234F1Z5' })).json()) as { id: string };
    const one = await get(`/admin/suppliers/${made.id}`, admin);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(made);
    expect(one.body).toMatchObject({ name: 'Zzone Pharma', version: 1, active: true });
    expect((await get(`/admin/suppliers/${made.id}`, nurse)).status).toBe(403);
    expect((await get(`/admin/suppliers/${randomUUID()}`, admin)).status).toBe(404);
    expect((await get('/admin/suppliers/bad', admin)).status).toBe(404);
  });
});
