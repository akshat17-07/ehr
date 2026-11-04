import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';
import type { Queryable } from '../../db/migrate.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { permissionsOf, requirePermission } from '../../permissions/check.js';
import {
  birthChange, birthsDeaths, changeBirth, changeDeath, deathChange, getBirth, getDeath, newBirth, newDeath, recordBirth, recordDeath,
  registerQuery, voidBirth, voidDeath,
} from './vital-events.js';

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** Reading one record: the people who record, and the compliance officer. */
const canRead = createMiddleware<AuthEnv>(async (c, next) => {
  const { effective } = await permissionsOf(c);
  if (!effective.includes('vital_events.record') && !effective.includes('compliance.registers')) {
    throw new AppError(403, 'forbidden', 'needs vital_events.record');
  }
  await next();
});

/**
 * The patient rules (sensitive labels, inactive patients) for the patient of a record. A patient that does not exist is
 * left to the module, which answers 422.
 */
async function guard(c: Context<AuthEnv>, db: Queryable, patientId: string): Promise<void> {
  let patient;
  try {
    patient = await getPatient(db, patientId);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return;
    throw err;
  }
  await assertPatientAccess(db, userOf(c), patient);
}

// Mounted at /staff/births.
export const birthsRoutes = new Hono<AuthEnv>()
  .post('/', requirePermission('vital_events.record'), async (c) => {
    const db = await dbOf(c);
    const input = newBirth.parse(await bodyOf(c));
    await guard(c, db, input.motherPatientId);
    const birth = await recordBirth(db, input, userOf(c).sub);
    auditDetails(c, { patientId: birth.motherPatientId, recordType: 'birth', recordId: birth.id });
    return c.json(birth, 201);
  })
  .get('/:id', canRead, async (c) => {
    const db = await dbOf(c);
    const birth = await getBirth(db, c.req.param('id'));
    await guard(c, db, birth.motherPatientId);
    auditDetails(c, { patientId: birth.motherPatientId, recordType: 'birth', recordId: birth.id });
    return c.json(birth);
  })
  .patch('/:id', requirePermission('vital_events.record'), async (c) => {
    const db = await dbOf(c);
    const input = birthChange.parse(await bodyOf(c));
    await guard(c, db, (await getBirth(db, c.req.param('id'))).motherPatientId);
    const birth = await changeBirth(db, c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: birth.motherPatientId, recordType: 'birth', recordId: birth.id, reason: input.reason });
    return c.json(birth);
  })
  .post('/:id/void', requirePermission('vital_events.record'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const db = await dbOf(c);
    await guard(c, db, (await getBirth(db, c.req.param('id'))).motherPatientId);
    const birth = await voidBirth(db, c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: birth.motherPatientId, recordType: 'birth', recordId: birth.id, reason });
    return c.json(birth);
  });

// Mounted at /staff/deaths.
export const deathsRoutes = new Hono<AuthEnv>()
  .post('/', requirePermission('vital_events.record'), async (c) => {
    const db = await dbOf(c);
    const input = newDeath.parse(await bodyOf(c));
    await guard(c, db, input.patientId);
    const death = await recordDeath(db, input, userOf(c).sub);
    auditDetails(c, { patientId: death.patientId, recordType: 'death', recordId: death.id });
    return c.json(death, 201);
  })
  .get('/:id', canRead, async (c) => {
    const db = await dbOf(c);
    const death = await getDeath(db, c.req.param('id'));
    await guard(c, db, death.patientId);
    auditDetails(c, { patientId: death.patientId, recordType: 'death', recordId: death.id });
    return c.json(death);
  })
  .patch('/:id', requirePermission('vital_events.record'), async (c) => {
    const db = await dbOf(c);
    const input = deathChange.parse(await bodyOf(c));
    await guard(c, db, (await getDeath(db, c.req.param('id'))).patientId);
    const death = await changeDeath(db, c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: death.patientId, recordType: 'death', recordId: death.id });
    return c.json(death);
  })
  .post('/:id/void', requirePermission('vital_events.record'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const db = await dbOf(c);
    await guard(c, db, (await getDeath(db, c.req.param('id'))).patientId);
    const death = await voidDeath(db, c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: death.patientId, recordType: 'death', recordId: death.id, reason });
    return c.json(death);
  });

// Mounted at /admin/registers/births-deaths (#330).
export const adminBirthsDeathsRoutes = new Hono<AuthEnv>().get('/', requirePermission('compliance.registers'), async (c) => {
  const q = registerQuery.parse(c.req.query());
  const out = await birthsDeaths(await dbOf(c), q);
  auditDetails(c, { action: 'print', recordType: 'register', recordId: `births-deaths ${q.from}..${q.to}` });
  return c.json(out);
});
