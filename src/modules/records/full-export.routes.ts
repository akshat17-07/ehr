import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireEnv } from '../../config/env.js';
import { LINK_SECONDS } from '../../files/signed-url.js';
import { AppError } from '../../middleware/errors.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, signerOf, startJobOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { getExport } from './exports.js';
import { startFullExport } from './full-export.js';

const body = z.object({ since: z.iso.datetime({ offset: true }).optional() }).strict();

/** An empty body is the same as {}; anything else must be a JSON object. */
async function bodyOf(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Mounted at /admin/fhir.
export const adminFhirRoutes = new Hono<AuthEnv>()
  // #348
  .post('/$export', requirePermission('fhir.export_all'), async (c) => {
    const { since } = body.parse(await bodyOf(c));
    const sinceDate = since ? new Date(since) : undefined;
    if (sinceDate && sinceDate.getTime() > Date.now()) {
      throw new AppError(422, 'invalid_input', 'since cannot be in the future');
    }
    const started = await startFullExport(await dbOf(c), { ...(sinceDate && { since: sinceDate }) }, userOf(c).sub, startJobOf(c));
    auditDetails(c, { action: 'print', recordType: 'export', recordId: started.id });
    return c.json(started, 202);
  });

// Mounted at /admin/exports.
export const adminExportsRoutes = new Hono<AuthEnv>()
  // #349: only full exports; a patient export is read at /staff/exports/{id}.
  .get('/:id', requirePermission('fhir.export_all'), async (c) => {
    const { s3Key, ...found } = await getExport(await dbOf(c), c.req.param('id'));
    if (found.kind !== 'full') throw new AppError(404, 'not_found', 'no such export');
    const downloadUrl = found.status === 'done' ? await signerOf(c)(requireEnv('EXPORTS_BUCKET'), s3Key, LINK_SECONDS) : undefined;
    auditDetails(c, { recordType: 'export', recordId: found.id });
    return c.json({ ...found, ...(downloadUrl && { downloadUrl }) });
  });
