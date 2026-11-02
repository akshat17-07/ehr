import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listSurgeries, planSurgery, SIDES, SURGERY_STATUSES, VENUES } from './surgeries.js';

const listQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), surgeonId: z.uuid().optional(), status: z.enum(SURGERY_STATUSES).optional() })
  .strict();

// consentDocumentIds come with documents (#211).
const newSurgery = z
  .object({
    patientId: z.uuid(),
    procedure: z.string().trim().min(3).max(200),
    site: z.string().trim().min(1).max(100).optional(),
    side: z.enum(SIDES).optional(),
    surgeonId: z.uuid(),
    teamIds: z.array(z.uuid()).max(15).optional(),
    scheduledAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    venue: z.enum(VENUES),
    partnerHospitalId: z.uuid().optional(),
    chargesPaise: z.number().int().min(0).max(10_000_000_000),
    instructions: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/surgeries */
export const surgeriesRoutes = new Hono<AuthEnv>()
  // #86
  .get('/', requirePermission('surgery.view'), async (c) => c.json(await listSurgeries(await dbOf(c), listQuery.parse(c.req.query()))))
  // #87
  .post('/', requirePermission('surgery.create'), async (c) => {
    const surgery = await planSurgery(await dbOf(c), newSurgery.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: surgery.patientId, recordType: 'surgery', recordId: surgery.id });
    return c.json(surgery, 201);
  });
