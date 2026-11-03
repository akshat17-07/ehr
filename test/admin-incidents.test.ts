import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const hour = 3_600_000;

type Incident = { id: string; status: string; title: string; detectedAt: string; certInDueBy: string; boardDueBy: string; events: { at: string; text: string; by: string }[] };
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const log = async (extra: Record<string, unknown> = {}, who = admin) => {
  const body = { title: 'Laptop lost', detectedAt: new Date(Date.now() - 2 * hour).toISOString(), kind: 'loss', description: 'Left in a taxi', ...extra };
  const res = await app.request('/admin/incidents', json(body), who);
  return { status: res.status, body: (await res.json()) as Incident };
};
const addEvent = async (id: string, body: unknown, who = admin) => {
  const res = await app.request(`/admin/incidents/${id}/events`, json(body), who);
  return { status: res.status, body: (await res.json()) as Incident & { error?: string } };
};

describe('POST /admin/incidents', () => {
  it('opens an incident with CERT-In 6 h and Board 72 h deadlines', async () => {
    const detectedAt = new Date(Date.now() - 3 * hour).toISOString();
    const { status, body } = await log({ detectedAt });
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'open', title: 'Laptop lost', events: [] });
    expect(new Date(body.certInDueBy).getTime()).toBe(new Date(detectedAt).getTime() + 6 * hour);
    expect(new Date(body.boardDueBy).getTime()).toBe(new Date(detectedAt).getTime() + 72 * hour);
  });

  it('refuses other users (403), a future detectedAt and extra fields (422)', async () => {
    expect((await log({}, doctor)).status).toBe(403);
    expect((await log({ detectedAt: new Date(Date.now() + 5 * hour).toISOString() })).status).toBe(422);
    expect((await log({ kind: 'fire' })).status).toBe(422);
    expect((await log({ extra: 1 })).status).toBe(422);
  });
});

describe('GET /admin/incidents', () => {
  it('lists newest incident first and filters by status', async () => {
    const older = (await log({ title: 'Older', detectedAt: new Date(Date.now() - 50 * hour).toISOString() })).body;
    const newer = (await log({ title: 'Newer', detectedAt: new Date(Date.now() - 1 * hour).toISOString() })).body;
    await addEvent(older.id, { text: 'Reported to CERT-In', status: 'reported' });
    const all = (await (await app.request('/admin/incidents', {}, admin)).json()) as Incident[];
    const ids = all.map((i) => i.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    const reported = (await (await app.request('/admin/incidents?status=reported', {}, admin)).json()) as Incident[];
    expect(reported.map((i) => i.id)).toContain(older.id);
    expect(reported.every((i) => i.status === 'reported')).toBe(true);
    expect((await app.request('/admin/incidents?status=bogus', {}, admin)).status).toBe(422);
    expect((await app.request('/admin/incidents', {}, doctor)).status).toBe(403);
  });
});

describe('POST /admin/incidents/:id/events', () => {
  it('adds events in time order, changes status, and keeps older events', async () => {
    const { body: made } = await log();
    const first = await addEvent(made.id, { text: 'Isolated the account' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('open');
    expect(first.body.events).toHaveLength(1);
    expect(first.body.events[0]).toMatchObject({ text: 'Isolated the account', by: seedId('a0000000', 1) });
    const second = await addEvent(made.id, { text: 'Told CERT-In', status: 'reported' });
    expect(second.body.status).toBe('reported');
    expect(second.body.events.map((e) => e.text)).toEqual(['Isolated the account', 'Told CERT-In']);
    const { rows } = await db.query('SELECT version FROM incidents WHERE id = $1', [made.id]);
    expect(rows[0]!.version).toBe(2);
  });

  it('409 closed on a closed incident, unless the call reopens it', async () => {
    const { body: made } = await log();
    expect((await addEvent(made.id, { text: 'Done', status: 'closed' })).body.status).toBe('closed');
    const refused = await addEvent(made.id, { text: 'More' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('closed');
    expect((await addEvent(made.id, { text: 'Still closed', status: 'closed' })).status).toBe(409);
    const reopened = await addEvent(made.id, { text: 'Found more', status: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.events).toHaveLength(2);
  });

  it('404 for an unknown or non-UUID id, 403 for others, 422 for bad bodies', async () => {
    expect((await addEvent(randomUUID(), { text: 'x' })).status).toBe(404);
    expect((await addEvent('not-a-uuid', { text: 'x' })).status).toBe(404);
    const { body: made } = await log();
    expect((await addEvent(made.id, { text: 'x' }, doctor)).status).toBe(403);
    expect((await addEvent(made.id, { text: '' })).status).toBe(422);
    expect((await addEvent(made.id, { text: 'x', status: 'gone' })).status).toBe(422);
  });
});
