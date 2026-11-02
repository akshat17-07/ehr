import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import type { FileUploads, StoredFile } from '../src/files/uploads.js';
import { createGrant } from '../src/permissions/grants.js';

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

describe('POST /staff/documents/{id}/complete', () => {
  const start = async (sha: string) => ((await (await app.request('/staff/documents/upload-url', json(file(sha)), doctor)).json()) as { document: { id: string; version: number } }).document;
  const complete = (id: string, who = doctor) => app.request(`/staff/documents/${id}/complete`, { method: 'POST' }, who);
  const keyOf = (id: string) => `patients/${ramesh}/${id}`;

  it('marks the document ready once the stored file matches; again just returns it', async () => {
    const doc = await start('c3'.repeat(32));
    expect(await (await complete(doc.id)).json()).toMatchObject({ error: 'not_uploaded' });
    stored.set(keyOf(doc.id), { sizeBytes: 182_000, sha256: 'c3'.repeat(32) });
    const res = await complete(doc.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: doc.id, status: 'ready', uploadedAt: expect.any(String), version: doc.version + 1 });
    expect(await (await complete(doc.id)).json()).toMatchObject({ status: 'ready', version: doc.version + 1 });
  });

  it('422 file_mismatch for another size or hash; the document stays pending', async () => {
    const doc = await start('d4'.repeat(32));
    stored.set(keyOf(doc.id), { sizeBytes: 182_001, sha256: 'd4'.repeat(32) });
    expect(await (await complete(doc.id)).json()).toMatchObject({ error: 'file_mismatch' });
    stored.set(keyOf(doc.id), { sizeBytes: 182_000, sha256: 'ee'.repeat(32) });
    expect(await (await complete(doc.id)).json()).toMatchObject({ error: 'file_mismatch' });
    stored.set(keyOf(doc.id), { sizeBytes: 182_000 });
    expect((await complete(doc.id)).status).toBe(422);
    expect((await db.query('SELECT status FROM documents WHERE id = $1', [doc.id])).rows[0]).toEqual({ status: 'pending' });
  });

  it('404 for none; 403 for reception', async () => {
    expect((await complete(seedId('d0c00000', 999))).status).toBe(404);
    expect((await complete('nope')).status).toBe(404);
    expect((await complete((await start('f5'.repeat(32))).id, reception)).status).toBe(403);
  });
});

describe('documentId links from other records', () => {
  const kavita = seedId('9a710000', 4);
  const MED = seedId('de000000', 1);
  const surgeonId = seedId('a0000000', 4);
  /** A ready document of the patient (as if uploaded through #94 and #95). */
  const readyDoc = async (patientId: string) =>
    String((await db.query(
      `INSERT INTO documents (id, status, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key, uploaded_at)
       VALUES (gen_random_uuid(), 'ready', 'x', 'x', $1, 'consent', 'form.pdf', 'application/pdf', 1000, md5(random()::text), 'k', now()) RETURNING id`,
      [patientId],
    )).rows[0]?.id);
  const pendingDoc = async (patientId: string) => {
    const id = await readyDoc(patientId);
    await db.query("UPDATE documents SET status = 'pending' WHERE id = $1", [id]);
    return id;
  };

  it('consents (#27) and order results (#60): the patient\'s own uploaded document only', async () => {
    const consent = (documentId: string) => app.request(`/staff/patients/${ramesh}/consents`, json({ kind: 'treatment', language: 'en', given: true, documentId }), reception);
    const mine = await readyDoc(ramesh);
    expect(await (await consent(mine)).json()).toMatchObject({ documentId: mine });
    expect((await consent(await readyDoc(kavita))).status).toBe(422);
    expect((await consent(await pendingDoc(ramesh))).status).toBe(422);

    const arrived = await app.request(`/staff/appointments/${seedId('a9900000', 1)}/check-in`, { method: 'POST' }, reception);
    const encounterId = ((await arrived.json()) as { encounter: { id: string } }).encounter.id;
    const order = (await (await app.request(`/staff/encounters/${encounterId}/orders`, json({ kind: 'lab', name: 'Lipid profile' }), doctor)).json()) as { id: string };
    const report = await readyDoc(ramesh);
    const result = await app.request(`/staff/orders/${order.id}/results`, json({ documentId: report }), doctor);
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ documentId: report });
    expect((await app.request(`/staff/orders/${order.id}/results`, json({ documentId: await readyDoc(kavita) }), doctor)).status).toBe(422);
  });

  it('Form F (#82) and MTP entries (#84)', async () => {
    for (const permission of ['pcpndt.write', 'mtp.write']) {
      await createGrant(db, { userId: 'dev-doctor', permission, scope: 'all', end: new Date(Date.now() + 86_400_000), grantorId: 'dev-admin', reason: 'Gyn roster' });
    }
    const opened = await app.request('/staff/encounters', json({ patientId: kavita, type: 'OPD', departmentId: MED, doctorId: seedId('a0000000', 3) }), doctor);
    const encounterId = ((await opened.json()) as { id: string }).id;
    const form = { indication: 'Dating scan', procedure: 'Ultrasound, obstetric', declarationSigned: true };
    expect((await app.request(`/staff/encounters/${encounterId}/form-f`, json({ ...form, documentId: await readyDoc(ramesh) }), doctor)).status).toBe(422);
    const signed = await readyDoc(kavita);
    expect(await (await app.request(`/staff/encounters/${encounterId}/form-f`, json({ ...form, documentId: signed }), doctor)).json()).toMatchObject({ documentId: signed });

    const entry = { patientId: kavita, admissionDate: '2026-10-20', gestationWeeks: 8, indication: 'Contraceptive failure', opinionDoctorIds: [seedId('a0000000', 3)] };
    const opinion = await readyDoc(kavita);
    expect(await (await app.request('/staff/mtp-register', json({ ...entry, documentId: opinion }), doctor)).json()).toMatchObject({ documentId: opinion });
    expect((await app.request('/staff/mtp-register', json({ ...entry, documentId: await pendingDoc(kavita) }), doctor)).status).toBe(422);
  });

  it('surgery consents (#87, #89) and implant stickers (#85)', async () => {
    const plan = (consentDocumentIds: string[]) =>
      app.request('/staff/surgeries', json({ patientId: ramesh, procedure: 'Hernia repair', surgeonId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), venue: 'own', chargesPaise: 3000000, consentDocumentIds }), doctor);
    const first = await readyDoc(ramesh);
    const surgery = (await (await plan([first, first])).json()) as { id: string; version: number; consentDocumentIds: string[] };
    expect(surgery.consentDocumentIds).toEqual([first]);
    expect((await plan([await readyDoc(kavita)])).status).toBe(422);
    const second = await readyDoc(ramesh);
    const patched = await app.request(`/staff/surgeries/${surgery.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: surgery.version, consentDocumentIds: [first, second] }) }, doctor);
    expect(await patched.json()).toMatchObject({ consentDocumentIds: [first, second] });

    const sticker = await readyDoc(ramesh);
    const implant = { name: 'Polypropylene mesh', batchNo: 'PM-9', mrpPaise: 450000 };
    expect(await (await app.request(`/staff/surgeries/${surgery.id}/implants`, json({ ...implant, stickerDocumentId: sticker }), doctor)).json()).toMatchObject({ stickerDocumentId: sticker });
    expect((await app.request(`/staff/surgeries/${surgery.id}/implants`, json({ ...implant, stickerDocumentId: await readyDoc(kavita) }), doctor)).status).toBe(422);
  });
});

describe('POST /staff/encounters/{id}/prescriptions/upload', () => {
  const irfan = seedId('9a710000', 3);
  const nurse = asStaff('dev-nurse', ['nurse']);
  const photo = async (patientId: string) =>
    String((await db.query(
      `INSERT INTO documents (id, status, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key, uploaded_at)
       VALUES (gen_random_uuid(), 'ready', 'x', 'x', $1, 'prescription', 'rx.jpg', 'image/jpeg', 90000, md5(random()::text), 'k', now()) RETURNING id`,
      [patientId],
    )).rows[0]?.id);
  const openFor = async (patientId: string) =>
    ((await (await app.request('/staff/encounters', json({ patientId, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) }), doctor)).json()) as { id: string }).id;
  const upload = (encounterId: string, body: unknown, who = doctor) => app.request(`/staff/encounters/${encounterId}/prescriptions/upload`, json(body), who);
  const line = { drugId: seedId('d0000000', 3), drugText: 'Amoxicillin 500 mg', dose: '1 cap', frequency: 'TDS', days: 5 };

  it('saves a draft with the photo, and any lines typed so far; no alerts yet', async () => {
    const encounterId = await openFor(irfan);
    const documentId = await photo(irfan);
    const res = await upload(encounterId, { documentId });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'draft', source: 'uploaded', documentId, lines: [], patientId: irfan, encounterId });
    const withLines = await upload(encounterId, { documentId, lines: [line] });
    expect(await withLines.json()).toMatchObject({ status: 'draft', lines: [line] });
  });

  it("422 for another patient's document or an unknown drug; 403 for a nurse; 404 for no encounter", async () => {
    const encounterId = await openFor(irfan);
    expect((await upload(encounterId, { documentId: await photo(ramesh) })).status).toBe(422);
    expect((await upload(encounterId, { documentId: await photo(irfan), lines: [{ ...line, drugId: seedId('d0000000', 999) }] })).status).toBe(422);
    expect((await upload(encounterId, { documentId: await photo(irfan) }, nurse)).status).toBe(403);
    expect((await upload(seedId('e0000000', 999), { documentId: await photo(irfan) })).status).toBe(404);
  });
});
