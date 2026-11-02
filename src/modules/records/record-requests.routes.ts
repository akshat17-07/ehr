import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { exportPatient, getExport } from './exports.js';
import { requireEnv } from '../../config/env.js';
import { LINK_SECONDS } from '../../files/signed-url.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, exportsOf, mailerOf, signerOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createRecordRequest, fulfilRecordRequest, listRecordRequests, rejectRecordRequest, RECORD_REQUEST_STATUSES, RECORD_SCOPES } from './record-requests.js';

const listQuery = pageQuery.extend({ status: z.enum(RECORD_REQUEST_STATUSES).optional(), overdue: z.enum(['true', 'false']).optional() }).strict();

const newRequest = z
  .object({
    patientId: z.uuid(),
    scope: z.enum(RECORD_SCOPES),
    encounterIds: z.array(z.uuid()).min(1).max(50).optional(),
    includeSensitive: z.boolean().optional(),
    email: z.email().max(200),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/record-requests.
export const recordRequestsRoutes = new Hono<AuthEnv>()
  // #145
  .get('/', requirePermission('records.release'), async (c) => c.json(await listRecordRequests(await dbOf(c), listQuery.parse(c.req.query()))))
  // #146
  .post('/', requirePermission('records.release'), async (c) => {
    const input = newRequest.parse(await bodyOf(c));
    const request = await createRecordRequest(await dbOf(c), input, 'counter', userOf(c).sub);
    auditDetails(c, { patientId: request.patientId, recordType: 'record_request', recordId: request.id });
    return c.json(request, 201);
  })
  // #147
  .post('/:id/fulfil', requirePermission('records.release'), async (c) => {
    const request = await fulfilRecordRequest(await dbOf(c), c.req.param('id'), { exportFiles: exportsOf(c), mailer: mailerOf(c) }, userOf(c).sub);
    auditDetails(c, { action: 'print', patientId: request.patientId, recordType: 'record_request', recordId: request.id });
    return c.json(request);
  })
  // #148
  .post('/:id/reject', requirePermission('records.release'), async (c) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).strict().parse(await bodyOf(c));
    const request = await rejectRecordRequest(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: request.patientId, recordType: 'record_request', recordId: request.id, reason });
    return c.json(request);
  });

// Mounted at /staff/fhir.
export const fhirRoutes = new Hono<AuthEnv>()
  // #150
  .post('/Patient/:id/$export', requirePermission('fhir.export'), async (c) => {
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    await assertPatientAccess(db, userOf(c), patient);
    const done = await exportPatient(db, patient.id, exportsOf(c), userOf(c).sub);
    auditDetails(c, { action: 'print', patientId: patient.id, recordType: 'export', recordId: done.id });
    return c.json(done, 202);
  });

// Mounted at /staff/exports.
export const exportsRoutes = new Hono<AuthEnv>()
  // #151: a 10-minute download link once done.
  .get('/:id', requirePermission('fhir.export'), async (c) => {
    const db = await dbOf(c);
    const { s3Key, ...found } = await getExport(db, c.req.param('id'));
    if (found.patientId) await assertPatientAccess(db, userOf(c), await getPatient(db, found.patientId));
    const downloadUrl = found.status === 'done' ? await signerOf(c)(requireEnv('EXPORTS_BUCKET'), s3Key, LINK_SECONDS) : undefined;
    auditDetails(c, { ...(found.patientId && { patientId: found.patientId }), recordType: 'export', recordId: found.id });
    return c.json({ ...found, ...(downloadUrl && { downloadUrl }) });
  });
