import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { permissionsOf, requirePermission } from '../../permissions/check.js';
import { APPROVAL_KINDS, listApprovals } from './approvals.js';

const listQuery = z.object({ kind: z.enum(APPROVAL_KINDS).optional() });

export const approvalsRoutes = new Hono<AuthEnv>()
  // #173
  .get('/', requirePermission('approval.view'), async (c) => {
    const { kind } = listQuery.parse(c.req.query());
    return c.json(await listApprovals(await dbOf(c), userOf(c).sub, (await permissionsOf(c)).effective, kind));
  });
