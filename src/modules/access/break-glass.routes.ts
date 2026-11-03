import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listBreakGlassEvents, REVIEW_OUTCOMES, reviewBreakGlass } from './break-glass.js';

// /admin/break-glass-events: the emergency access used (#30), listed and reviewed afterwards.

const listQuery = pageQuery.extend({
  reviewed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
const reviewBody = z.object({ outcome: z.enum(REVIEW_OUTCOMES), note: z.string().trim().min(3).max(500) }).strict();

export const adminBreakGlassRoutes = new Hono<AuthEnv>()
  // #183
  .get('/', requirePermission('audit.read'), async (c) => c.json(await listBreakGlassEvents(await dbOf(c), listQuery.parse(c.req.query()))))
  // #184
  .post('/:id/review', requirePermission('audit.review'), async (c) => {
    const body = reviewBody.parse(await c.req.json().catch(() => undefined));
    const event = await reviewBreakGlass(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: event.patientId, recordType: 'break_glass_event', recordId: event.id, reason: `${body.outcome}: ${body.note}` });
    return c.json(event);
  });
