import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ENCOUNTER_STATUSES, ENCOUNTER_TYPES, listEncounters } from './encounters.js';

// Encounters (api-list.md #36-#40), mounted at /staff/encounters.

const listQuery = pageQuery.extend({
  date: z.iso.date().optional(),
  doctorId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  type: z.enum(ENCOUNTER_TYPES).optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
});

export const encountersRoutes = new Hono<AuthEnv>()
  // #36
  .get('/', requirePermission('encounter.view'), async (c) => c.json(await listEncounters(await dbOf(c), listQuery.parse(c.req.query()))));
