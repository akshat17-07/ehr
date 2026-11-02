import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { BUILT_IN_BUNDLES } from '../src/permissions/bundles.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);

describe('GET /admin/bundles', () => {
  it('lists the bundles by name for Admin and Head Doctor', async () => {
    for (const who of [admin, head]) {
      const res = await app.request('/admin/bundles', {}, who);
      expect(res.status).toBe(200);
      const bundles = (await res.json()) as { name: string; permissions: string[]; builtIn: boolean }[];
      expect(bundles.map((b) => b.name)).toEqual(['billing', 'health_data', 'reception', 'records', 'store', 'tpa']);
      expect(bundles.find((b) => b.name === 'tpa')).toMatchObject({ builtIn: true, permissions: [...BUILT_IN_BUNDLES.tpa] });
    }
  });

  it('403 for a doctor (not a management group)', async () => {
    expect((await app.request('/admin/bundles', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /admin/bundles', () => {
  const post = (body: unknown, who = admin) => app.request('/admin/bundles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('adds a bundle with sorted permissions; the name cannot be reused', async () => {
    const res = await post({ name: 'lab_desk', permissions: ['result.record', 'document.view', 'result.record'] });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string };
    expect(made).toMatchObject({ name: 'lab_desk', permissions: ['document.view', 'result.record'], builtIn: false, version: 1 });
    expect(((await (await app.request('/admin/bundles', {}, admin)).json()) as { name: string }[]).map((b) => b.name)).toContain('lab_desk');
    expect(await (await post({ name: 'lab_desk', permissions: ['document.view'] })).json()).toMatchObject({ error: 'duplicate', bundleId: made.id });
  });

  it('422 for unknown, Admin-only or grant-only permissions or a bad name; 403 for a Head Doctor', async () => {
    expect((await post({ name: 'x_desk', permissions: ['no.such'] })).status).toBe(422);
    expect((await post({ name: 'x_desk', permissions: ['settings.bundles'] })).status).toBe(422);
    expect((await post({ name: 'x_desk', permissions: ['mtp.view'] })).status).toBe(422);
    expect((await post({ name: 'Front Desk', permissions: ['document.view'] })).status).toBe(422);
    expect((await post({ name: 'x_desk', permissions: ['document.view'] }, head)).status).toBe(403);
  });
});

describe('PATCH /admin/bundles/{id}', () => {
  const send = (method: string, path: string, body: unknown, who = admin) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const make = async (name: string) => (await (await send('POST', '/admin/bundles', { name, permissions: ['document.view'] })).json()) as { id: string; version: number };

  it('changes the permissions and name with a version check', async () => {
    const b = await make('ward_clerk');
    const res = await send('PATCH', `/admin/bundles/${b.id}`, { version: 1, name: 'ward_desk', permissions: ['vitals.record', 'document.view'], reason: 'covers vitals too' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'ward_desk', permissions: ['document.view', 'vitals.record'], version: 2 });
    expect((await send('PATCH', `/admin/bundles/${b.id}`, { version: 1, permissions: ['document.view'] })).status).toBe(409);
  });

  it('refuses built-in bundles, renaming one users hold, and a taken name', async () => {
    const tpa = ((await (await app.request('/admin/bundles', {}, admin)).json()) as { id: string; name: string }[]).find((x) => x.name === 'tpa')!.id;
    expect(await (await send('PATCH', `/admin/bundles/${tpa}`, { version: 1, permissions: ['claim.view'] })).json()).toMatchObject({ error: 'built_in' });
    const held = await make('night_desk');
    await db.query(`INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny, bundles) VALUES ('${randomUUID()}', 'active', 'test', 'test', 'test-holder', '[]', '[]', '["night_desk"]')`);
    expect(await (await send('PATCH', `/admin/bundles/${held.id}`, { version: 1, name: 'late_desk' })).json()).toMatchObject({ error: 'in_use', users: 1 });
    expect((await send('PATCH', `/admin/bundles/${held.id}`, { version: 1, permissions: ['document.view', 'vitals.record'] })).status).toBe(200);
    const other = await make('day_desk');
    expect(await (await send('PATCH', `/admin/bundles/${other.id}`, { version: 1, name: 'ward_desk' })).json()).toMatchObject({ error: 'duplicate' });
  });

  it('404 for no bundle; 422 for nothing to change; 403 for a Head Doctor', async () => {
    const b = await make('spare_desk');
    expect((await send('PATCH', '/admin/bundles/00000000-0000-4000-8000-000000000999', { version: 1, name: 'zz_desk' })).status).toBe(404);
    expect((await send('PATCH', `/admin/bundles/${b.id}`, { version: 1 })).status).toBe(422);
    expect((await send('PATCH', `/admin/bundles/${b.id}`, { version: 1, name: 'zz_desk' }, head)).status).toBe(403);
  });
});
