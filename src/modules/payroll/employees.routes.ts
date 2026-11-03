import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { employeesQuery, listEmployees } from './employees.js';

// Mounted at /admin/employees.
export const adminEmployeesRoutes = new Hono<AuthEnv>()
  // #204
  .get('/', requirePermission('payroll.employee'), async (c) => {
    const query = employeesQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'employee' });
    return c.json(await listEmployees(await dbOf(c), query));
  });
