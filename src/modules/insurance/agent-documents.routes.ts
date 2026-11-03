import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireEnv } from '../../config/env.js';
import type { Queryable } from '../../db/migrate.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, uploadsOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';
import { DOCUMENT_MIMES, MAX_DOCUMENT_BYTES, startUpload, type Document } from '../documents/documents.js';
import { assertAgentPatient, notLinked } from './agent-access.js';

// /other/insurance/documents (api-list.md 8.x, #267): an insurance agent uploads files for a linked patient. The agent
// only ever touches files it uploaded itself (created_by = its sub, type insurance or id_proof); other documents of
// the patient are never returned or revealed.

export const AGENT_DOCUMENT_TYPES = ['insurance', 'id_proof'] as const;
const TYPE_LIST = AGENT_DOCUMENT_TYPES.map((t) => `'${t}'`).join(', ');

/** A Document as the agent sees it: no s3 key, no staff ids, no hash. */
export type AgentDocument = Pick<Document, 'id' | 'patientId' | 'type' | 'fileName' | 'mime' | 'sizeBytes' | 'status' | 'createdAt'>;

export function toAgentDocument(d: Document): AgentDocument {
  return { id: d.id, patientId: d.patientId, type: d.type, fileName: d.fileName, mime: d.mime, sizeBytes: d.sizeBytes, status: d.status, createdAt: d.createdAt };
}

/** SQL for "documents.* is the caller's own agent upload" (`by` is a parameter placeholder such as '$2'). */
export const OWN_DOCUMENT = (by: string) => `documents.created_by = ${by} AND documents.type IN (${TYPE_LIST})`;

const newUpload = z
  .object({
    patientId: z.uuid(),
    type: z.enum(AGENT_DOCUMENT_TYPES),
    fileName: z.string().trim().min(1).max(200),
    mime: z.enum(DOCUMENT_MIMES),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
    sha256: z.string().toLowerCase().regex(/^[0-9a-f]{64}$/, '64 hex characters'),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** 409 already_on_file if the patient has this file (pending or ready) from anyone but this agent. */
async function assertNoForeignCopy(db: Queryable, patientId: string, sha256: string, by: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM documents WHERE patient_id = $1 AND sha256 = $2 AND status IN ('pending', 'ready') AND NOT (${OWN_DOCUMENT('$3')}) LIMIT 1`,
    [patientId, sha256, by],
  );
  if (rows[0]) throw new AppError(409, 'already_on_file', 'this file is already on file for the patient');
}

// Mounted at /other/insurance/documents.
export const agentDocumentsRoutes = new Hono<AuthEnv>()
  // #400 (api-list #267): access first (403), then the body (422).
  .post('/upload-url', async (c) => {
    const raw = await bodyOf(c);
    const patientId = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).patientId : undefined;
    if (typeof patientId !== 'string') throw notLinked();
    await assertAgentPatient(c, patientId);
    const input = newUpload.parse(raw);
    const db = await dbOf(c);
    const by = userOf(c).sub;
    await assertNoForeignCopy(db, input.patientId, input.sha256, by);
    const started = await startUpload(db, uploadsOf(c), requireEnv('FILES_BUCKET'), input, by);
    auditDetails(c, { patientId: started.document.patientId, recordType: 'document', recordId: started.document.id });
    const document = toAgentDocument(started.document);
    return 'duplicate' in started
      ? c.json({ document, duplicate: true }, 200)
      : c.json({ document, uploadUrl: started.uploadUrl, uploadHeaders: started.uploadHeaders, expiresAt: started.expiresAt }, 201);
  });
