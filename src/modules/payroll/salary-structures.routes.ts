import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listSalaryStructures } from './salary-structures.js';

// Mounted at /admin/salary-structures.
export const adminSalaryStructuresRoutes = new Hono<AuthEnv>()
  // #208
  .get('/', requirePermission('payroll.employee'), async (c) => {
    auditDetails(c, { recordType: 'salary_structure' });
    return c.json(await listSalaryStructures(await dbOf(c)));
  });
