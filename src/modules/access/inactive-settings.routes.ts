import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import type { Queryable } from '../../db/migrate.js';
import { APPROVERS, INACTIVE_MODES, inactiveSettingsVersion, listInactiveSettings, replaceInactiveSettings, SETTING_ROLES, type InactiveSetting } from './inactive-settings.js';

// /admin/settings/inactive-access: the inactive-patient rule per role or user (#185, #186).

const setting = z
  .object({
    appliesTo: z.enum(['role', 'user']),
    role: z.enum(SETTING_ROLES).optional(),
    userId: z.uuid().optional(),
    mode: z.enum(INACTIVE_MODES),
    days: z.number().int().min(1).max(3650),
    approver: z.enum(APPROVERS),
    accessHours: z.number().int().min(1).max(720),
  })
  .strict()
  .refine((s) => (s.appliesTo === 'role' ? s.role !== undefined && s.userId === undefined : s.userId !== undefined && s.role === undefined), {
    message: 'a role setting names a role, a user setting names a userId',
  });
const patchBody = z
  .object({ settings: z.array(setting).max(200), version: z.number().int().min(0), reason: z.string().trim().min(3).max(500).optional() })
  .strict();

/** The answer for both calls: the list and its version (send the version back with the next PATCH). */
const current = async (db: Queryable) => ({ version: await inactiveSettingsVersion(db), settings: await listInactiveSettings(db) });

export const adminInactiveSettingsRoutes = new Hono<AuthEnv>()
  // #185
  .get('/', requirePermission('settings.view'), async (c) => c.json(await current(await dbOf(c))))
  // #186 (Admin only)
  .patch('/', requirePermission('settings.manage'), async (c) => {
    const body = patchBody.parse(await c.req.json().catch(() => undefined));
    const db = await dbOf(c);
    await replaceInactiveSettings(db, body.settings as InactiveSetting[], userOf(c).sub, body.reason, body.version);
    auditDetails(c, { recordType: 'inactive_settings', ...(body.reason && { reason: body.reason }) });
    return c.json(await current(db));
  });
