import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { drugRegister, type RegisterKind } from './registers.js';

const period = z.object({ from: z.iso.date(), to: z.iso.date() });

const print = (kind: RegisterKind) => async (c: Context<AuthEnv>) => c.json(await drugRegister(await dbOf(c), kind, period.parse(c.req.query())));

/** /staff/registers */
export const registersRoutes = new Hono<AuthEnv>()
  // #113
  .get('/h1', requirePermission('register.print'), print('h1'))
  // #114
  .get('/x', requirePermission('register.print'), print('x'));
