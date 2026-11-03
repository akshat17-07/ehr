import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addSalaryStructure, listSalaryStructures, newSalaryStructureBody } from './salary-structures.js';

// Mounted at /admin/salary-structures.
export const adminSalaryStructuresRoutes = new Hono<AuthEnv>()
  // #208
  .get('/', requirePermission('payroll.employee'), async (c) => {
    auditDetails(c, { recordType: 'salary_structure' });
    return c.json(await listSalaryStructures(await dbOf(c)));
  })
  // #321
  .post('/', requirePermission('payroll.employee'), async (c) => {
    const body = newSalaryStructureBody.parse(await c.req.json().catch(() => undefined));
    const s = await addSalaryStructure(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, {
      action: 'create',
      recordType: 'salary_structure',
      recordId: s.id,
      changes: {
        name: [null, s.name],
        basicPaise: [null, s.basicPaise],
        hraPaise: [null, s.hraPaise],
        allowances: [null, s.allowances],
        epf: [null, s.epf],
        esi: [null, s.esi],
        professionalTax: [null, s.professionalTax],
        tdsMonthlyPaise: [null, s.tdsMonthlyPaise],
      },
    });
    return c.json(s, 201);
  });
