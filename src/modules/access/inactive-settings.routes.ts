import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { APPROVERS, INACTIVE_MODES, listInactiveSettings, replaceInactiveSettings, SETTING_ROLES, type InactiveSetting } from './inactive-settings.js';

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
const patchBody = z.object({ settings: z.array(setting).max(200), reason: z.string().trim().min(3).max(500).optional() }).strict();

export const adminInactiveSettingsRoutes = new Hono<AuthEnv>()
  // #185
  .get('/', requirePermission('settings.view'), async (c) => c.json(await listInactiveSettings(await dbOf(c))))
  // #186 (Admin only)
  .patch('/', requirePermission('settings.manage'), async (c) => {
    const body = patchBody.parse(await c.req.json().catch(() => undefined));
    const settings = await replaceInactiveSettings(await dbOf(c), body.settings as InactiveSetting[], userOf(c).sub, body.reason);
    auditDetails(c, { recordType: 'inactive_settings', ...(body.reason && { reason: body.reason }) });
    return c.json(settings);
  });
