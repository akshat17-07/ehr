import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, exportsOf, mailerOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createRecordRequest, fulfilRecordRequest, listRecordRequests, RECORD_REQUEST_STATUSES, RECORD_SCOPES } from './record-requests.js';

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
  });
