import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { permissionsOf, requirePermission } from '../../permissions/check.js';
import { dayClose } from './day-close.js';
import { opdReport, reportDepartments } from './opd.js';

const dayCloseQuery = z.object({ date: z.iso.date(), userId: z.string().trim().min(1).max(200).optional() }).strict();

const opdQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), departmentId: z.uuid().optional(), doctorId: z.uuid().optional() })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from is after to', path: ['to'] });

// Mounted at /staff/reports.
export const reportsRoutes = new Hono<AuthEnv>()
  // #130
  .get('/day-close', requirePermission('report.finance'), async (c) => c.json(await dayClose(await dbOf(c), dayCloseQuery.parse(c.req.query()))))
  // #149: doctors see their own departments only.
  .get('/opd', requirePermission('report.clinical'), async (c) => {
    const query = opdQuery.parse(c.req.query());
    const db = await dbOf(c);
    const perms = await permissionsOf(c);
    return c.json(await opdReport(db, query, await reportDepartments(db, perms.userId, perms.type)));
  });
