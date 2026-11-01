import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { listDepartments } from './departments.js';
import { getHospital } from './hospital.js';
import { listTariffs } from './tariffs.js';

// Reference data every staff member reads (api-list.md 7.1 "Reference data").

const boolText = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const referenceRoutes = new Hono<AuthEnv>()
  // #8
  .get('/hospital', async (c) => c.json(await getHospital(await dbOf(c))))
  // #9
  .get('/departments', async (c) => {
    const query = z.object({ active: boolText }).parse(c.req.query());
    return c.json(await listDepartments(await dbOf(c), query));
  })
  // #10
  .get('/tariffs', async (c) => {
    const query = z
      .object({
        departmentId: z.uuid().optional(),
        setting: z.enum(['opd', 'ipd']).optional(),
        q: z.string().trim().min(2).max(100).optional(),
        on: z.iso.date().optional(),
      })
      .parse(c.req.query());
    return c.json(await listTariffs(await dbOf(c), query));
  });
