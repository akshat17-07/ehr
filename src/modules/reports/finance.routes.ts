import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ledger, ledgerQuery } from './ledger.js';
import { collections, collectionsQuery, surgeryMargin, surgeryMarginQuery } from './finance.js';

// Mounted at /admin/reports.
export const adminReportsRoutes = new Hono<AuthEnv>()
  // #233
  .get('/surgery-margin', requirePermission('report.finance'), async (c) => {
    const query = surgeryMarginQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'report', reason: `surgery-margin from=${query.from} to=${query.to}${query.surgeonId ? ` surgeonId=${query.surgeonId}` : ''}` });
    return c.json(await surgeryMargin(await dbOf(c), query));
  })
  // #234
  .get('/collections', requirePermission('report.finance'), async (c) => {
    const query = collectionsQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'report', reason: `collections from=${query.from} to=${query.to} groupBy=${query.groupBy}` });
    return c.json(await collections(await dbOf(c), query));
  });

// Mounted at /admin/ledger.
export const adminLedgerRoutes = new Hono<AuthEnv>()
  // #347
  .get('/', requirePermission('report.finance'), async (c) => {
    const query = ledgerQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'ledger', reason: `ledger from=${query.from} to=${query.to}${query.account ? ` account=${query.account}` : ''}${query.cursor ? ' (next page)' : ''}` });
    return c.json(await ledger(await dbOf(c), query));
  });
