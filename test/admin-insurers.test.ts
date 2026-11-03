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
const head = asStaff('dev-head-doctor', ['head_doctor']);

const post = (body: unknown, who = admin) =>
  app.request('/admin/insurers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
type Insurer = { id: string; version: number; name: string; code?: string; active: boolean };

describe('POST /admin/insurers', () => {
  it('adds an active insurer at version 1, lists it, and audits it', async () => {
    const res = await post({ name: '  Star Test Insurance ', code: ' STAR ' });
    expect(res.status).toBe(201);
    const insurer = (await res.json()) as Insurer;
    expect(insurer).toMatchObject({ name: 'Star Test Insurance', code: 'STAR', active: true, version: 1 });
    const list = (await (await app.request('/staff/insurers', {}, admin)).json()) as Insurer[];
    expect(list.find((i) => i.id === insurer.id)).toMatchObject({ name: 'Star Test Insurance', active: true });
    const { rows } = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'insurer' AND record_id = $1", [insurer.id]);
    expect(rows).toHaveLength(1);
  });

  it('works without a code', async () => {
    const res = await post({ name: 'No Code Insurance' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Insurer).code).toBeUndefined();
  });

  it('403 for a Head Doctor', async () => {
    expect((await post({ name: 'Nope Insurance' }, head)).status).toBe(403);
  });

  it('422 for a missing, blank or too long name, a blank or long code, or an unknown field', async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ name: '   ' })).status).toBe(422);
    expect((await post({ name: 'x'.repeat(201) })).status).toBe(422);
    expect((await post({ name: 'Bad Code Insurance', code: '  ' })).status).toBe(422);
    expect((await post({ name: 'Bad Code Insurance', code: 'c'.repeat(51) })).status).toBe(422);
    expect((await post({ name: 'Extra Insurance', active: false })).status).toBe(422);
  });

  it('409 duplicate for a name already taken', async () => {
    expect((await post({ name: 'Twin Insurance' })).status).toBe(201);
    const dup = await post({ name: ' Twin Insurance ' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
  });
});
