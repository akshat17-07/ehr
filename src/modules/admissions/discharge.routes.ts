import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { rxLine } from '../prescriptions/prescriptions.routes.js';

// Discharge summaries by id (api-list.md #75-#76), mounted at /staff/discharge-summaries. Written on the encounter (#74).

const longText = z.string().trim().min(1).max(10_000);

export const summaryFields = {
  diagnosisText: z.string().trim().min(2).max(1000),
  course: longText,
  procedures: longText.optional(),
  medicinesOnDischarge: z.array(rxLine).max(30),
  advice: longText,
  followUpDate: z.iso.date().optional(),
};

export const dischargeRoutes = new Hono<AuthEnv>();
