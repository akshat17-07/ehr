import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { approvePayrollRun, approveRunBody, createPayrollRun, getPayrollRun, listPayrollRuns, newRunBody, runsQuery } from './runs.js';

// Mounted at /admin/payroll/runs.
export const adminPayrollRunsRoutes = new Hono<AuthEnv>()
  // #325
  .get('/', requirePermission('payroll.view'), async (c) => {
    const query = runsQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'payroll_run' });
    return c.json(await listPayrollRuns(await dbOf(c), query));
  })
  // #326
  .get('/:id', requirePermission('payroll.view'), async (c) => {
    const run = await getPayrollRun(await dbOf(c), c.req.param('id'));
    auditDetails(c, { recordType: 'payroll_run', recordId: run.id });
    return c.json(run);
  })
  // #327
  .post('/:id/approve', requirePermission('approval.payroll'), async (c) => {
    const body = approveRunBody.parse(await c.req.json().catch(() => undefined));
    const run = await approvePayrollRun(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, {
      action: 'update',
      recordType: 'payroll_run',
      recordId: run.id,
      changes: { status: ['draft', 'approved'] },
      ...(body.note && { reason: body.note }),
    });
    return c.json(run);
  })
  // #324
  .post('/', requirePermission('payroll.run'), async (c) => {
    const body = newRunBody.parse(await c.req.json().catch(() => undefined));
    const run = await createPayrollRun(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, {
      action: 'create',
      recordType: 'payroll_run',
      recordId: run.id,
      changes: { month: [null, run.month], employees: [null, (run.payslips ?? []).length], totalNetPaise: [null, run.totalNetPaise] },
    });
    return c.json(run, 201);
  });
