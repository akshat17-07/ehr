import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import type { FileUploads, StoredFile } from '../src/files/uploads.js';

const db = await openLocalDb();
await seedDev(db);
env.FILES_BUCKET = 'files-test';
/** What the fake bucket holds, by key. */
const stored = new Map<string, StoredFile>();
const uploads: FileUploads = {
  signPut: vi.fn(async (bucket: string, key: string) => ({ url: `https://s3.test/${bucket}/${key}?put`, headers: { 'x-test': '1' } })),
  head: async (_bucket, key) => stored.get(key),
};
const app = createApp({ db: async () => db, uploads });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const reception = asStaff('dev-reception', ['staff']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ramesh = seedId('9a710000', 1);
const file = (sha: string) => ({ patientId: ramesh, type: 'lab_report', fileName: 'CBC 2026-10-30.pdf', mime: 'application/pdf', sizeBytes: 182_000, sha256: sha });

describe('POST /staff/documents/upload-url', () => {
  const start = (body: unknown, who = doctor) => app.request('/staff/documents/upload-url', json(body), who);

  it('gives a signed link for a new file; asking again renews the link for the same document', async () => {
    const res = await start(file('A1'.repeat(32)));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { id: string }; uploadUrl: string; expiresAt: string };
    expect(body).toMatchObject({
      document: { status: 'pending', patientId: ramesh, type: 'lab_report', fileName: 'CBC 2026-10-30.pdf', sha256: 'a1'.repeat(32), sizeBytes: 182_000 },
      uploadUrl: `https://s3.test/files-test/patients/${ramesh}/${body.document.id}?put`,
      uploadHeaders: { 'x-test': '1' },
    });
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    const again = (await (await start(file('a1'.repeat(32)))).json()) as { document: { id: string } };
    expect(again.document.id).toBe(body.document.id);
  });

  it('200 duplicate when the patient already has this file', async () => {
    await db.query("UPDATE documents SET status = 'ready', uploaded_at = now() WHERE sha256 = $1", ['a1'.repeat(32)]);
    const res = await start(file('a1'.repeat(32)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true, document: { status: 'ready', sha256: 'a1'.repeat(32) } });
  });

  it('422 for a big file, another type or a bad hash; 404 for no patient; 403 for reception', async () => {
    expect((await start({ ...file('b2'.repeat(32)), sizeBytes: 11 * 1024 * 1024 })).status).toBe(422);
    expect((await start({ ...file('b2'.repeat(32)), mime: 'application/zip' })).status).toBe(422);
    expect((await start(file('xyz'))).status).toBe(422);
    expect((await start({ ...file('b2'.repeat(32)), patientId: seedId('9a710000', 999) })).status).toBe(404);
    expect((await start(file('b2'.repeat(32)), reception)).status).toBe(403);
  });
});
