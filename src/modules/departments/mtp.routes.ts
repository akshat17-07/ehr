import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { assertPermission, requirePermission } from '../../permissions/check.js';
import { addMtpEntry, listMtp } from './mtp.js';

const listQuery = pageQuery.extend({ from: z.iso.date().optional(), to: z.iso.date().optional() });

// documentId comes with documents (#211).
const newEntry = z
  .object({
    patientId: z.uuid(),
    admissionDate: z.iso.date(),
    gestationWeeks: z.number().int().min(1).max(40),
    indication: z.string().trim().min(3).max(500),
    opinionDoctorIds: z.array(z.uuid()).min(1).max(5),
    procedureDate: z.iso.date().optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/mtp-register. A register spans departments, so only a grant for "all" opens it. */
export const mtpRoutes = new Hono<AuthEnv>()
  // #83
  .get('/', requirePermission('mtp.view'), async (c) => c.json(await listMtp(await dbOf(c), listQuery.parse(c.req.query()))))
  // #84: a grant for all or for this patient.
  .post('/', async (c) => {
    const input = newEntry.parse(await bodyOf(c));
    await assertPermission(c, 'mtp.write', { patientId: input.patientId });
    const entry = await addMtpEntry(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: entry.patientId, recordType: 'mtp_entry', recordId: entry.id });
    return c.json(entry, 201);
  });
