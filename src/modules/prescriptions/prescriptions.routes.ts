import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';

// Prescriptions by id (api-list.md #64-#68), mounted at /staff/prescriptions. They are written in an encounter (#62).

const short = (max: number) => z.string().trim().min(1).max(max);

export const rxLine = z
  .object({
    drugId: z.uuid().optional(),
    drugText: z.string().trim().min(2).max(200),
    strength: short(50).optional(),
    form: short(50).optional(),
    dose: short(50),
    frequency: short(50),
    route: short(30).optional(),
    days: z.number().int().min(1).max(365),
    quantity: z.number().int().min(1).max(10_000).optional(),
    instructions: short(500).optional(),
  })
  .strict();
export const rxLines = z.array(rxLine).min(1).max(30);
export const acknowledgedAlerts = z.array(z.string().max(40)).max(100).optional();

export const prescriptionsRoutes = new Hono<AuthEnv>();
