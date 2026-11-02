import { describe, expect, it } from 'vitest';
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
