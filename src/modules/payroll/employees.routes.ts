import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addEmployee, employeesQuery, getEmployee, listEmployees, newEmployeeBody } from './employees.js';

// Mounted at /admin/employees.
export const adminEmployeesRoutes = new Hono<AuthEnv>()
  // #204
  .get('/', requirePermission('payroll.employee'), async (c) => {
    const query = employeesQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'employee' });
    return c.json(await listEmployees(await dbOf(c), query));
  })
  // #318
  .get('/:id', requirePermission('payroll.employee'), async (c) => {
    const employee = await getEmployee(await dbOf(c), c.req.param('id'));
    auditDetails(c, { recordType: 'employee', recordId: employee.id });
    return c.json(employee);
  })
  // #205
  .post('/', requirePermission('payroll.employee'), async (c) => {
    const body = newEmployeeBody.parse(await c.req.json().catch(() => undefined));
    const employee = await addEmployee(await dbOf(c), body, userOf(c).sub);
    // Never PAN, UAN, ESIC or bank values in the audit row.
    auditDetails(c, {
      action: 'create',
      recordType: 'employee',
      recordId: employee.id,
      changes: {
        name: [null, employee.name],
        designation: [null, employee.designation],
        joinDate: [null, employee.joinDate],
        salaryStructureId: [null, employee.salaryStructureId],
        ...(body.userId && { userId: [null, body.userId] }),
      },
    });
    return c.json(employee, 201);
  });
