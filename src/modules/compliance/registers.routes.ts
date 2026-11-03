import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { notifiableDiseases, notifiableQuery, pcpndtMonthly, pcpndtQuery } from './registers.js';

// Mounted at /admin/registers.
export const adminRegistersRoutes = new Hono<AuthEnv>()
  // #329
  .get('/pcpndt-monthly', requirePermission('compliance.registers'), async (c) => {
    const { month } = pcpndtQuery.parse(c.req.query());
    const out = await pcpndtMonthly(await dbOf(c), month);
    auditDetails(c, { action: 'print', recordType: 'register', recordId: `pcpndt-monthly ${month}` });
    return c.json(out);
  })
  // #331
  .get('/notifiable-diseases', requirePermission('compliance.registers'), async (c) => {
    const q = notifiableQuery.parse(c.req.query());
    const out = await notifiableDiseases(await dbOf(c), q);
    auditDetails(c, { action: 'print', recordType: 'register', recordId: `notifiable-diseases ${q.from}..${q.to}` });
    return c.json(out);
  });
