import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listDrugBatches } from '../inventory/batches.js';
import { listDepartments } from './departments.js';
import { DRUG_SCHEDULES, searchDrugs } from './drugs.js';
import { getHospital } from './hospital.js';
import { listInsurers, listPartnerHospitals, listTpas } from './payers.js';
import { listTariffs, rateBoardRows } from './tariffs.js';

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
  })
  // #11
  .get('/tariffs/rate-board', async (c) => {
    const { lang } = z.object({ lang: z.enum(['en', 'hi', 'both']).default('both') }).parse(c.req.query());
    const db = await dbOf(c);
    return c.json({ hospital: await getHospital(db), rows: await rateBoardRows(db, lang) });
  })
  // #12
  .get('/drugs', async (c) => {
    const query = z
      .object({
        q: z.string().trim().min(2).max(100),
        schedule: z.enum(DRUG_SCHEDULES).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(c.req.query());
    return c.json(await searchDrugs(await dbOf(c), query));
  })
  // #13
  .get('/drugs/:id/batches', requirePermission('stock.view'), async (c) => {
    const query = z.object({ inStock: boolText }).parse(c.req.query());
    return c.json(await listDrugBatches(await dbOf(c), c.req.param('id'), query));
  })
  // #14
  .get('/partner-hospitals', async (c) => c.json(await listPartnerHospitals(await dbOf(c))))
  // #15
  .get('/insurers', async (c) => c.json(await listInsurers(await dbOf(c))))
  // #16
  .get('/tpas', async (c) => c.json(await listTpas(await dbOf(c))));
