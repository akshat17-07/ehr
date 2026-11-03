import { Hono } from 'hono';
import { auditDetails } from '../middleware/audit.js';
import type { AuthEnv } from '../middleware/auth.js';
import { dbOf } from '../middleware/context.js';
import { requirePermission } from '../permissions/check.js';
import { auditListQuery, listAudit, verifyAudit } from './access-log.js';

// Mounted at /admin/audit.
export const adminAuditRoutes = new Hono<AuthEnv>()
  // #341
  .get('/verify', requirePermission('audit.read'), async (c) => {
    auditDetails(c, { recordType: 'audit_verify' });
    return c.json(await verifyAudit(await dbOf(c)));
  })
  // #340: reading the log is audited with the filters used, never the rows read
  .get('/', requirePermission('audit.read'), async (c) => {
    const query = auditListQuery.parse(c.req.query());
    const page = await listAudit(await dbOf(c), query);
    const { limit: _limit, cursor: _cursor, ...filters } = query;
    auditDetails(c, {
      recordType: 'audit_log',
      ...(filters.patientId && { patientId: filters.patientId }),
      ...(Object.keys(filters).length > 0 && { reason: `filters: ${JSON.stringify(filters)}` }),
    });
    return c.json(page);
  });
