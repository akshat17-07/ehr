import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addReferrer, searchReferrers } from './referrers.js';

const searchQuery = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

const newReferrer = z
  .object({
    name: z.string().trim().min(2).max(200),
    clinic: z.string().trim().min(1).max(200).optional(),
    town: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'a 10-digit Indian mobile number').optional(),
    regNo: z.string().trim().min(2).max(50).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/referrers.
export const referrersRoutes = new Hono<AuthEnv>()
  // #141
  .get('/', requirePermission('referrer.view'), async (c) => c.json(await searchReferrers(await dbOf(c), searchQuery.parse(c.req.query()))))
  // #142
  .post('/', requirePermission('referrer.create_pseudo'), async (c) => {
    const input = newReferrer.parse(await bodyOf(c));
    const referrer = await addReferrer(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'referrer', recordId: referrer.id });
    return c.json(referrer, 201);
  });
