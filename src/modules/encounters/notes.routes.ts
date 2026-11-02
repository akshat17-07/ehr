import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { updateNote } from './notes.js';

// Notes by id (api-list.md #46-#48), mounted at /staff/notes. Notes are written in an encounter (#45).

export const noteText = z.string().trim().min(1).max(20_000);
const version = z.number().int().min(1);
const noteChange = z.object({ version, text: noteText }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const notesRoutes = new Hono<AuthEnv>()
  // #46
  .patch('/:id', requirePermission('note.write'), async (c) => {
    const change = noteChange.parse(await bodyOf(c));
    const note = await updateNote(await dbOf(c), c.req.param('id'), change, userOf(c).sub);
    auditDetails(c, { patientId: note.patientId, recordType: 'note', recordId: note.id });
    return c.json(note);
  });
