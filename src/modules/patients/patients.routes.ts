import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { searchPatients } from './patients.js';

// /staff/patients (api-list.md 6.3).

const searchQuery = pageQuery.extend({ q: z.string().trim().min(1).max(100) });

export const patientsRoutes = new Hono<AuthEnv>()
  // #19
  .get('/', requirePermission('patient.search'), async (c) => {
    const query = searchQuery.parse(c.req.query());
    return c.json(await searchPatients(await dbOf(c), query));
  });
