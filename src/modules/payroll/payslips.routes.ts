import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { listMyPayslips } from './payslips.js';

// /staff/me/payslips: the caller's own payslips only.

const listQuery = pageQuery.extend({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export const myPayslipsRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const query = listQuery.parse(c.req.query());
  return c.json(await listMyPayslips(await dbOf(c), userOf(c).sub, query));
});
