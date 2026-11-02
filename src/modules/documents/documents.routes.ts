import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireEnv } from '../../config/env.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, signerOf, uploadsOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { completeUpload, DOCUMENT_MIMES, DOCUMENT_TYPES, documentViewUrl, MAX_DOCUMENT_BYTES, retagDocument, startUpload } from './documents.js';

const newUpload = z
  .object({
    patientId: z.uuid(),
    type: z.enum(DOCUMENT_TYPES),
    fileName: z.string().trim().min(1).max(200),
    mime: z.enum(DOCUMENT_MIMES),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
    sha256: z.string().toLowerCase().regex(/^[0-9a-f]{64}$/, '64 hex characters'),
  })
  .strict();

const retag = z.object({ version: z.number().int().min(1), type: z.enum(DOCUMENT_TYPES) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/documents */
export const documentsRoutes = new Hono<AuthEnv>()
  // #94
  .post('/upload-url', requirePermission('document.upload'), async (c) => {
    const input = newUpload.parse(await bodyOf(c));
    const started = await startUpload(await dbOf(c), uploadsOf(c), requireEnv('FILES_BUCKET'), input, userOf(c).sub);
    auditDetails(c, { patientId: started.document.patientId, recordType: 'document', recordId: started.document.id });
    return c.json(started, 'duplicate' in started ? 200 : 201);
  })
  // #95
  .post('/:id/complete', requirePermission('document.upload'), async (c) => {
    const document = await completeUpload(await dbOf(c), uploadsOf(c), requireEnv('FILES_BUCKET'), c.req.param('id'), userOf(c).sub);
    auditDetails(c, { patientId: document.patientId, recordType: 'document', recordId: document.id });
    return c.json(document);
  })
  // #97: audited as a view of the document; a clinical read, so the inactive-patient rule applies.
  .get('/:id/view-url', requirePermission('document.view'), async (c) => {
    const db = await dbOf(c);
    const { document, ...link } = await documentViewUrl(db, signerOf(c), requireEnv('FILES_BUCKET'), c.req.param('id'));
    auditDetails(c, { patientId: document.patientId, recordType: 'document', recordId: document.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, document.patientId));
    return c.json(link);
  })
  // #98
  .post('/:id/retag', requirePermission('document.upload'), async (c) => {
    const input = retag.parse(await bodyOf(c));
    const document = await retagDocument(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: document.patientId, recordType: 'document', recordId: document.id });
    return c.json(document);
  });
