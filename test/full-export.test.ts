import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import type { JobEvent } from '../src/jobs/index.js';

env.EXPORTS_BUCKET = 'exports-test';
const db = await openLocalDb();
await seedDev(db);
const started: JobEvent[] = [];
let startFails = false;
const app = createApp({
  db: async () => db,
  startJob: async (event) => {
    if (startFails) throw new Error('lambda down');
    started.push(event);
  },
  signUrl: async (bucket, key, seconds) => `https://s3.test/${bucket}/${key}?get=${seconds}`,
});

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const headDoctor = asStaff('dev-head-doctor', ['head_doctor']);
const post = (body?: string, who = admin) =>
  app.request('/admin/fhir/$export', { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body }) }, who);
const get = (id: string, who = admin) => app.request(`/admin/exports/${id}`, {}, who);
const row = async (id: string) => (await db.query('SELECT * FROM exports WHERE id = $1', [id])).rows[0]!;

describe('POST /admin/fhir/$export (#348)', () => {
  it('202 with a running full export and starts the job once', async () => {
    started.length = 0;
    const res = await post('{}');
    expect(res.status).toBe(202);
    const made = (await res.json()) as { id: string };
    expect(made).toMatchObject({ status: 'running', kind: 'full', createdBy: 'dev-admin' });
    expect(made).not.toHaveProperty('s3Key');
    expect(started).toEqual([{ job: 'fhir_export', exportId: made.id }]);
    expect((await row(made.id)).s3_key).toBe(`fhir/full/${made.id}/export.ndjson.gz`);
  });

  it('an empty body works; since is passed to the job, not stored', async () => {
    started.length = 0;
    expect((await post()).status).toBe(202);
    expect(started[0]).toEqual({ job: 'fhir_export', exportId: expect.any(String) });
    const since = '2026-01-01T00:00:00.000Z';
    expect((await post(JSON.stringify({ since }))).status).toBe(202);
    expect(started[1]).toMatchObject({ job: 'fhir_export', since });
  });

  it('422 for a bad body, a bad date, an unknown field or a future since', async () => {
    started.length = 0;
    expect((await post('not json')).status).toBe(422);
    expect((await post('{"since":"yesterday"}')).status).toBe(422);
    expect((await post('{"extra":1}')).status).toBe(422);
    expect((await post(JSON.stringify({ since: new Date(Date.now() + 86_400_000).toISOString() }))).status).toBe(422);
    expect(started).toHaveLength(0);
  });

  it('500 and a failed row when the job cannot be started', async () => {
    startFails = true;
    const before = Number((await db.query("SELECT count(*)::int AS n FROM exports WHERE kind = 'full'")).rows[0]!.n);
    const res = await post('{}');
    startFails = false;
    expect(res.status).toBe(500);
    const { rows } = await db.query("SELECT * FROM exports WHERE kind = 'full'");
    expect(rows).toHaveLength(before + 1);
    const failed = rows.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.finished_at).not.toBeNull();
  });

  it('403 for a head doctor and a doctor, 401 with no login', async () => {
    expect((await post('{}', headDoctor)).status).toBe(403);
    expect((await post('{}', asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await app.request('/admin/fhir/$export', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('GET /admin/exports/{id} (#349)', () => {
  const insert = async (kind: string, status: string, key: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO exports (id, status, created_by, updated_by, created_at, updated_at, kind, s3_key)
       VALUES ($1, $2, 'test', 'test', now(), now(), $3, $4)`,
      [id, status, kind, key],
    );
    return id;
  };

  it('running has no link; done has a 600 s signed link', async () => {
    const running = await insert('full', 'running', 'fhir/full/a/export.ndjson.gz');
    const r = (await (await get(running)).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ id: running, status: 'running', kind: 'full' });
    expect(r).not.toHaveProperty('downloadUrl');
    expect(r).not.toHaveProperty('s3Key');
    const done = await insert('full', 'done', 'fhir/full/b/export.ndjson.gz');
    const d = (await (await get(done)).json()) as Record<string, unknown>;
    expect(d.downloadUrl).toBe('https://s3.test/exports-test/fhir/full/b/export.ndjson.gz?get=600');
    const failed = await insert('full', 'failed', 'fhir/full/c/export.ndjson.gz');
    expect(await (await get(failed)).json()).not.toHaveProperty('downloadUrl');
  });

  it('404 for a patient export, an unknown id or a non-uuid', async () => {
    const patient = await insert('patient', 'done', 'fhir/p/x.json');
    expect((await get(patient)).status).toBe(404);
    expect((await get(randomUUID())).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
  });

  it('403 for a non-admin, 401 with no login', async () => {
    const id = await insert('full', 'running', 'k');
    expect((await get(id, headDoctor)).status).toBe(403);
    expect((await app.request(`/admin/exports/${id}`)).status).toBe(401);
  });
});
