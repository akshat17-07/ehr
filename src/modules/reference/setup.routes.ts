import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addDepartment } from './departments.js';

// Hospital setup for the Admin (api-list.md 7.2 "Hospital setup (edit)", #189-#200). Staff read the same data in
// reference.routes.ts. Each write is audited with the record it changed.

const text = (max: number) => z.string().trim().min(1).max(max);

const newDepartment = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'upper-case letters and digits, 2 to 10, starting with a letter'),
    nameEn: text(100),
    nameHi: text(100),
  })
  .strict();

export const setupAdminRoutes = new Hono<AuthEnv>()
  // #190 (Admin only)
  .post('/departments', requirePermission('settings.manage'), async (c) => {
    const input = newDepartment.parse(await c.req.json().catch(() => undefined));
    const department = await addDepartment(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'department', recordId: department.id });
    return c.json(department, 201);
  });
