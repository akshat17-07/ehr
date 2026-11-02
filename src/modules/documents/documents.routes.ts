import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireEnv } from '../../config/env.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, uploadsOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { DOCUMENT_MIMES, DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, startUpload } from './documents.js';

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
  });
