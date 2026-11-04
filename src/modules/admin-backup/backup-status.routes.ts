import { Hono } from 'hono';
import { backupStatus } from '../../jobs/backup-status.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';

// /admin/backup-status (#344): how the nightly backups are doing.
export const adminBackupStatusRoutes = new Hono<AuthEnv>().get('/', requirePermission('settings.view'), async (c) =>
  c.json(await backupStatus(await dbOf(c), new Date())),
);
