import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { getHospital } from './hospital.js';

// Reference data every staff member reads (api-list.md 7.1 "Reference data").

export const referenceRoutes = new Hono<AuthEnv>()
  // #8
  .get('/hospital', async (c) => c.json(await getHospital(await dbOf(c))));
