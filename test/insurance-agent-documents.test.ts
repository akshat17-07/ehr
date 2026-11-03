import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import type { FileUploads, StoredFile } from '../src/files/uploads.js';

// #400-#401: the agent's own uploads and attaching them to a claim.

const db = await openLocalDb();
await seedDev(db);
env.FILES_BUCKET = 'files-test';
const stored = new Map<string, StoredFile>();
const uploads: FileUploads = {
  signPut: vi.fn(async (bucket: string, key: string) => ({ url: `https://s3.test/${bucket}/${key}?put`, headers: { 'x-test': '1' } })),
  head: async (_bucket, key) => stored.get(key),
};
const app = createApp({ db: async () => db, uploads });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const agent = asStaff('dev-insurance', ['insurance']);
const doctor = asStaff('dev-doctor', ['doctor']);

const star = seedId('1a000000', 1);
const [ramesh, sita, irfan] = [1, 2, 3].map((n) => seedId('9a710000', n)) as [string, string, string];
const agentId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-insurance'")).rows[0]?.id);

for (const p of [ramesh, sita]) {
  await db.query(
    `INSERT INTO agent_links (id, status, created_at, created_by, updated_by, patient_id, agent_user_id, from_date, to_date)
     VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'test', 'test', $2, $3, '2026-01-01', NULL)`,
    [randomUUID(), p, agentId],
  );
}

async function insertClaim(patientId: string, status: string) {
  const id = randomUUID();
  const policyId = randomUUID();
  await db.query(
    `INSERT INTO policies (id, status, created_at, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, holder_name, valid_from, valid_to)
     VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'test', 'test', $2, $3, $4, $5, 'Holder', '2020-01-01', '2099-12-31')`,
    [policyId, patientId, star, seedId('1b000000', 1), `P-${policyId.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO claims (id, status, created_at, updated_at, created_by, updated_by, patient_id, policy_id, insurer_id, kind, amount_claimed_paise, submitted_at)
     VALUES ($1, $2, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', 'dev-tpa', 'dev-tpa', $3, $4, $5, 'reimbursement', 5000000, $6)`,
    [id, status, patientId, policyId, star, status === 'draft' ? null : '2026-02-01T00:00:00Z'],
  );
  return id;
}

const rClaim = await insertClaim(ramesh, 'submitted');
const rDraft = await insertClaim(ramesh, 'draft');
const iClaim = await insertClaim(irfan, 'submitted'); // irfan has no link

const json = { 'content-type': 'application/json' };
const post = (path: string, body: unknown, who = agent) => app.request(`/other/insurance${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }, who);
const sha = (c: string) => c.repeat(64);
const file = (patientId: string, c: string, type = 'insurance') => ({ patientId, type, fileName: 'policy.pdf', mime: 'application/pdf', sizeBytes: 1000, sha256: sha(c) });
const FORBIDDEN = { error: 'forbidden', message: 'not a patient linked to this agent' };

/** A document row not made through the agent route. */
async function insertDoc(patientId: string, by: string, type: string, status: string, c: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO documents (id, status, created_at, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key)
     VALUES ($1, $2, '2026-02-01T00:00:00Z', $3, $3, $4, $5, 'x.pdf', 'application/pdf', 1000, $6, $7)`,
    [id, status, by, patientId, type, sha(c), `patients/${patientId}/${id}`],
  );
  return id;
}

describe('POST /other/insurance/documents/upload-url (#400)', () => {
  it('201 with the stripped document and a link; asking again renews it for the same document', async () => {
    const res = await post('/documents/upload-url', file(ramesh, 'a'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: Record<string, unknown>; uploadUrl: string; uploadHeaders: unknown; expiresAt: string };
    expect(body.document).toEqual({ id: expect.any(String), patientId: ramesh, type: 'insurance', fileName: 'policy.pdf', mime: 'application/pdf', sizeBytes: 1000, status: 'pending', createdAt: expect.any(String) });
    expect(body.uploadUrl).toContain(`patients/${ramesh}/${String(body.document.id)}`);
    expect(JSON.stringify(body.document)).not.toMatch(/s3|sha256|created_by|createdBy/);
    const audit = await db.query("SELECT patient_id FROM audit_events WHERE record_type = 'document' AND record_id = $1", [body.document.id]);
    expect(audit.rows[0]).toMatchObject({ patient_id: ramesh });
    const again = await post('/documents/upload-url', file(ramesh, 'a'));
    expect(again.status).toBe(201);
    expect(((await again.json()) as { document: { id: string } }).document.id).toBe(body.document.id);
  });

  it('200 duplicate for its own ready file', async () => {
    await db.query("UPDATE documents SET status = 'ready', uploaded_at = now() WHERE sha256 = $1", [sha('a')]);
    const res = await post('/documents/upload-url', file(ramesh, 'a'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true, document: { status: 'ready' } });
  });

  it('409 already_on_file for a hospital or other agent file with the same hash, no id leaked', async () => {
    const hospital = await insertDoc(ramesh, 'dev-reception', 'insurance', 'ready', 'b');
    const res = await post('/documents/upload-url', file(ramesh, 'b'));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'already_on_file' });
    expect(text).not.toContain(hospital);
    const other = await insertDoc(ramesh, 'dev-insurance-2', 'insurance', 'pending', 'c');
    const res2 = await post('/documents/upload-url', file(ramesh, 'c'));
    expect(res2.status).toBe(409);
    expect(await res2.text()).not.toContain(other);
  });

  it('422 for another type or bad body; 403 first for unlinked patient or no patientId; doctor 403', async () => {
    expect((await post('/documents/upload-url', file(ramesh, 'd', 'lab_report'))).status).toBe(422);
    expect((await post('/documents/upload-url', { ...file(ramesh, 'd'), sha256: 'xyz' })).status).toBe(422);
    for (const body of [{ ...file(irfan, 'd'), type: 'lab_report', extra: 1 }, { type: 'x' }, { patientId: 'nope' }, file(randomUUID(), 'd')]) {
      const res = await post('/documents/upload-url', body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
    }
    expect((await post('/documents/upload-url', file(ramesh, 'd'), doctor)).status).toBe(403);
  });
});

describe('POST /other/insurance/claims/{id}/documents (#401)', () => {
  it('completes a pending own file and attaches it', async () => {
    const up = (await (await post('/documents/upload-url', file(ramesh, 'e'))).json()) as { document: { id: string } };
    const key = (await db.query('SELECT s3_key FROM documents WHERE id = $1', [up.document.id])).rows[0]?.s3_key as string;
    const early = await post(`/claims/${rClaim}/documents`, { documentIds: [up.document.id] });
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ error: 'not_uploaded' });
    stored.set(key, { sizeBytes: 1000, sha256: sha('e') });
    const res = await post(`/claims/${rClaim}/documents`, { documentIds: [up.document.id, up.document.id] });
    expect(res.status).toBe(200);
    const claim = (await res.json()) as Record<string, unknown> & { documentIds: string[] };
    expect(claim.documentIds).toEqual([up.document.id]);
    expect(claim).not.toHaveProperty('createdBy');
    const doc = await db.query('SELECT status FROM documents WHERE id = $1', [up.document.id]);
    expect(doc.rows[0]?.status).toBe('ready');
    const audit = await db.query("SELECT patient_id FROM audit_events WHERE record_type = 'claim' AND record_id = $1 AND action = 'create'", [rClaim]);
    expect(audit.rows[0]).toMatchObject({ patient_id: ramesh });
  });

  it('422 invalid_input, same message, for hospital, other agent, other type, other patient, unknown documents', async () => {
    const ids = [
      await insertDoc(ramesh, 'dev-reception', 'insurance', 'ready', '2'),
      await insertDoc(ramesh, 'dev-insurance-2', 'insurance', 'ready', '3'),
      await insertDoc(ramesh, 'dev-insurance', 'lab_report', 'ready', '4'),
      await insertDoc(sita, 'dev-insurance', 'insurance', 'ready', '1'),
      randomUUID(),
    ];
    const messages = new Set<string>();
    for (const id of ids) {
      const res = await post(`/claims/${rClaim}/documents`, { documentIds: [id] });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_input');
      messages.add(body.message);
    }
    expect(messages.size).toBe(1);
  });

  it('422 for a bad body; generic 403 for draft, unlinked, unknown, malformed claim; doctor 403', async () => {
    expect((await post(`/claims/${rClaim}/documents`, { documentIds: [] })).status).toBe(422);
    expect((await post(`/claims/${rClaim}/documents`, { documentIds: ['x'] })).status).toBe(422);
    expect((await post(`/claims/${rClaim}/documents`, { documentIds: [randomUUID()], extra: 1 })).status).toBe(422);
    for (const id of [rDraft, iClaim, randomUUID(), 'not-a-uuid']) {
      const res = await post(`/claims/${id}/documents`, { nope: true });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
    }
    expect((await post(`/claims/${rClaim}/documents`, { documentIds: [randomUUID()] }, doctor)).status).toBe(403);
  });
});
