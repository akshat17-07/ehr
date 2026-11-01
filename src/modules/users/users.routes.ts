import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { accountsOf, dbOf, userOf } from '../../middleware/context.js';
import { STAFF_TYPES } from '../../permissions/defaults.js';
import { requirePermission } from '../../permissions/check.js';
import { createUser, getUser, listUsers, updateUser } from './users.js';

// /admin/users: staff accounts (api-list.md 7.2).

const boolText = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const listQuery = pageQuery.extend({
  type: z.enum(STAFF_TYPES).optional(),
  departmentId: z.uuid().optional(),
  active: boolText,
  q: z.string().trim().min(2).max(100).optional(),
});

// Indian mobile numbers: 10 digits starting 6-9 (a +91 or 0 in front is dropped).
const mobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'a 10-digit Indian mobile number'));

const optionalText = z.string().trim().min(1).max(200).optional();

const newUser = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.email().max(254),
    mobile,
    type: z.enum(['doctor', 'nurse', 'staff', 'medical', 'insurance', 'gp', 'admin']),
    departmentIds: z.array(z.uuid()).max(20).default([]),
    councilName: optionalText,
    councilRegNo: optionalText,
    regValidTill: z.iso.date().optional(),
    pharmacistRegNo: optionalText,
    bundles: z.array(z.string().min(1).max(50)).max(20).default([]),
  })
  .strict()
  .superRefine((u, ctx) => {
    if (u.type !== 'doctor') return;
    for (const key of ['councilName', 'councilRegNo', 'regValidTill'] as const) {
      if (!u[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for doctors' });
    }
  });

const clearable = z.string().trim().min(1).max(200).nullable().optional();

const userChange = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(2).max(100).optional(),
    mobile: mobile.optional(),
    departmentIds: z.array(z.uuid()).max(20).optional(),
    councilName: clearable,
    councilRegNo: clearable,
    regValidTill: z.iso.date().nullable().optional(),
    pharmacistRegNo: clearable,
    reason: z.string().trim().min(5).max(500).optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).some((k) => !['version', 'reason'].includes(k)), 'nothing to change');

export const usersRoutes = new Hono<AuthEnv>()
  .get('/', requirePermission('user.view'), async (c) => {
    const query = listQuery.parse(c.req.query());
    return c.json(await listUsers(await dbOf(c), query));
  })
  .post('/', requirePermission('user.create'), async (c) => {
    const input = newUser.parse(await c.req.json().catch(() => undefined));
    return c.json(await createUser(await dbOf(c), accountsOf(c), input, userOf(c).sub), 201);
  })
  .get('/:id', requirePermission('user.view'), async (c) => c.json(await getUser(await dbOf(c), c.req.param('id'))))
  .patch('/:id', requirePermission('user.update'), async (c) => {
    const change = userChange.parse(await c.req.json().catch(() => undefined));
    return c.json(await updateUser(await dbOf(c), c.req.param('id'), change, userOf(c).sub));
  });
