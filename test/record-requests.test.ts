import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import type { Mail } from '../src/mail/mailer.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
env.SHARE_URL = 'https://ehr.test/share/';
/** What the fake exports bucket holds, by key, and the emails sent. */
const exported = new Map<string, string>();
const sent: Mail[] = [];
let mailDown = false;
const app = createApp({
  db: async () => db,
  exportFiles: { put: async (key, body) => void exported.set(key, body) },
  mailer: {
    send: vi.fn(async (mail: Mail) => {
      if (mailDown) throw new Error('SES down');
      sent.push(mail);
    }),
  },
});

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const ramesh = seedId('9a710000', 1);

/** A request row straight in the table, made `hoursAgo` ago (POST comes at #146). */
async function insertRequest(hoursAgo: number, status = 'pending') {
  const id = randomUUID();
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  await db.query(
    `INSERT INTO record_requests (id, status, created_at, updated_at, created_by, updated_by, patient_id, requested_by, scope, include_sensitive, email)
     VALUES ($1, $2, $3, $3, 'test', 'test', $4, 'patient', 'full', false, 'ramesh@example.in')`,
    [id, status, at, ramesh],
  );
  return id;
}

describe('GET /staff/record-requests', () => {
  it('lists oldest first with a 72-hour due time, filtered by status and overdue', async () => {
    const late = await insertRequest(80);
    const fresh = await insertRequest(2);
    const done = await insertRequest(90, 'fulfilled');
    const list = async (q = '') => ((await (await app.request(`/staff/record-requests${q}`, {}, admin)).json()) as { items: { id: string; dueBy: string }[] }).items;
    const all = await list();
    expect(all.map((r) => r.id)).toEqual([done, late, fresh]);
    expect(all[2]).toMatchObject({ status: 'pending', patientId: ramesh, requestedBy: 'patient', scope: 'full', includeSensitive: false, email: 'ramesh@example.in' });
    const due = new Date(all[2]!.dueBy).getTime() - Date.now();
    expect(due).toBeGreaterThan(69 * 3_600_000);
    expect(due).toBeLessThan(71 * 3_600_000);
    expect((await list('?overdue=true')).map((r) => r.id)).toEqual([late]);
    expect((await list('?overdue=false')).map((r) => r.id)).toEqual([done, fresh]);
    expect((await list('?status=fulfilled')).map((r) => r.id)).toEqual([done]);
  });

  it('403 without records.release (a doctor); 422 for a bad status', async () => {
    expect((await app.request('/staff/record-requests', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
    expect((await app.request('/staff/record-requests?status=lost', {}, admin)).status).toBe(422);
  });
});

describe('POST /staff/record-requests', () => {
  const post = (body: unknown, who = admin) => app.request('/staff/record-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const irfan = seedId('9a710000', 3);
  const openVisit = async (patientId: string) => {
    const body = { patientId, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) };
    const res = await app.request('/staff/encounters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, asStaff('dev-doctor', ['doctor']));
    return ((await res.json()) as { id: string }).id;
  };

  it('takes a request at the counter, due in 72 hours', async () => {
    const res = await post({ patientId: ramesh, scope: 'full', email: 'ramesh@example.in' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { createdAt: string; dueBy: string };
    expect(made).toMatchObject({ status: 'pending', patientId: ramesh, requestedBy: 'counter', scope: 'full', includeSensitive: false, createdBy: 'dev-admin' });
    expect(new Date(made.dueBy).getTime() - new Date(made.createdAt).getTime()).toBe(72 * 3_600_000);
  });

  it('scope encounter needs the patient own encounters', async () => {
    const visit = await openVisit(irfan);
    const ok = await post({ patientId: irfan, scope: 'encounter', encounterIds: [visit], includeSensitive: true, email: 'irfan@example.in' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ scope: 'encounter', encounterIds: [visit], includeSensitive: true });
    expect((await post({ patientId: ramesh, scope: 'encounter', encounterIds: [visit], email: 'r@example.in' })).status).toBe(422);
    expect((await post({ patientId: irfan, scope: 'encounter', email: 'r@example.in' })).status).toBe(422);
    expect((await post({ patientId: irfan, scope: 'full', encounterIds: [visit], email: 'r@example.in' })).status).toBe(422);
  });

  it('422 for a bad email; 404 for no patient; 403 for a doctor', async () => {
    expect((await post({ patientId: ramesh, scope: 'full', email: 'not-an-email' })).status).toBe(422);
    expect((await post({ patientId: seedId('9a710000', 999), scope: 'full', email: 'x@example.in' })).status).toBe(404);
    expect((await post({ patientId: ramesh, scope: 'full', email: 'x@example.in' }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /staff/record-requests/{id}/fulfil', () => {
  const kavita = seedId('9a710000', 4);
  const call = (path: string, body?: unknown, who = admin) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }, who);
  const openVisit = async () => {
    const body = { patientId: kavita, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) };
    const id = ((await (await call('/staff/encounters', body, asStaff('dev-doctor', ['doctor']))).json()) as { id: string }).id;
    return id;
  };
  const diagnose = (encounterId: string, text: string) =>
    db.query(`INSERT INTO diagnoses (id, status, created_by, updated_by, encounter_id, patient_id, icd10, text, kind) VALUES ($1, 'active', 'test', 'test', $2, $3, 'J06.9', $4, 'final')`, [
      randomUUID(), encounterId, kavita, text,
    ]);

  it('builds the copy for the chosen visits, emails a 7-day link and marks it fulfilled', async () => {
    const [first, second] = [await openVisit(), await openVisit()];
    await diagnose(first, 'Upper respiratory infection');
    await diagnose(second, 'Sprained ankle');
    const made = (await (await call('/staff/record-requests', { patientId: kavita, scope: 'encounter', encounterIds: [first], email: 'kavita@example.in' })).json()) as { id: string };
    const res = await call(`/staff/record-requests/${made.id}/fulfil`);
    expect(res.status).toBe(200);
    const done = (await res.json()) as { status: string; shareLinkExpiresAt: string; updatedAt: string };
    expect(done.status).toBe('fulfilled');
    expect(new Date(done.shareLinkExpiresAt).getTime() - new Date(done.updatedAt).getTime()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    const [key, html] = [...exported].find(([k]) => k.startsWith(`record-copies/${made.id}/`))!;
    expect(key).toMatch(/\.html$/);
    expect(html).toContain('Upper respiratory infection');
    expect(html).not.toContain('Sprained ankle');
    const mail = sent.at(-1)!;
    expect(mail.to).toBe('kavita@example.in');
    const token = /https:\/\/ehr\.test\/share\/([\w-]+)/.exec(mail.text)![1];
    const { rows } = await db.query('SELECT token_hash, s3_key, email FROM share_links WHERE record_request_id = $1', [made.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ s3_key: key, email: 'kavita@example.in' });
    expect(rows[0]!.token_hash).not.toBe(token);
    expect((await call(`/staff/record-requests/${made.id}/fulfil`)).status).toBe(409);
  });

  it('stays pending if the email cannot be sent; 404 for no request; 403 for a doctor', async () => {
    const made = (await (await call('/staff/record-requests', { patientId: kavita, scope: 'documents', email: 'kavita@example.in' })).json()) as { id: string };
    mailDown = true;
    expect((await call(`/staff/record-requests/${made.id}/fulfil`)).status).toBe(500);
    mailDown = false;
    const { rows } = await db.query('SELECT status FROM record_requests WHERE id = $1', [made.id]);
    expect(rows[0]!.status).toBe('pending');
    expect((await db.query('SELECT 1 FROM share_links WHERE record_request_id = $1', [made.id])).rows).toHaveLength(0);
    expect((await call(`/staff/record-requests/${randomUUID()}/fulfil`)).status).toBe(404);
    expect((await call(`/staff/record-requests/${made.id}/fulfil`, {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /staff/record-requests/{id}/reject', () => {
  const call = (path: string, body: unknown, who = admin) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const newRequest = async () =>
    ((await (await call('/staff/record-requests', { patientId: ramesh, scope: 'full', email: 'ramesh@example.in' })).json()) as { id: string }).id;

  it('rejects a pending request with a reason kept in its history; only once', async () => {
    const id = await newRequest();
    const res = await call(`/staff/record-requests/${id}/reject`, { reason: 'Asked by someone who is not the patient' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: 'rejected', updatedBy: 'dev-admin' });
    const { rows } = await db.query('SELECT reason FROM record_requests_versions WHERE record_id = $1 ORDER BY version DESC LIMIT 1', [id]);
    expect(rows[0]?.reason).toBe('Asked by someone who is not the patient');
    expect((await call(`/staff/record-requests/${id}/reject`, { reason: 'again please' })).status).toBe(409);
  });

  it('422 without a reason; 404 for no request; 403 for a doctor', async () => {
    const id = await newRequest();
    expect((await call(`/staff/record-requests/${id}/reject`, {})).status).toBe(422);
    expect((await call(`/staff/record-requests/${randomUUID()}/reject`, { reason: 'not found' })).status).toBe(404);
    expect((await call(`/staff/record-requests/${id}/reject`, { reason: 'no access' }, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
