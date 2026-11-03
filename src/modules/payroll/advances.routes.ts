import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addAdvance, newAdvanceBody } from './advances.js';

// Mounted at /admin/advances.
export const adminAdvancesRoutes = new Hono<AuthEnv>()
  // #323
  .post('/', requirePermission('payroll.employee'), async (c) => {
    const body = newAdvanceBody.parse(await c.req.json().catch(() => undefined));
    const advance = await addAdvance(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, {
      action: 'create',
      recordType: 'advance',
      recordId: advance.id,
      changes: {
        employeeId: [null, advance.employeeId],
        amountPaise: [null, advance.amountPaise],
        givenOn: [null, advance.givenOn],
        recoverPerMonthPaise: [null, advance.recoverPerMonthPaise],
      },
    });
    return c.json(advance, 201);
  });
