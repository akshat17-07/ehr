import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createPayrollRun, newRunBody } from './runs.js';

// Mounted at /admin/payroll/runs.
export const adminPayrollRunsRoutes = new Hono<AuthEnv>()
  // #324
  .post('/', requirePermission('payroll.run'), async (c) => {
    const body = newRunBody.parse(await c.req.json().catch(() => undefined));
    const run = await createPayrollRun(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, {
      action: 'create',
      recordType: 'payroll_run',
      recordId: run.id,
      changes: { month: [null, run.month], employees: [null, run.payslips.length], totalNetPaise: [null, run.totalNetPaise] },
    });
    return c.json(run, 201);
  });
