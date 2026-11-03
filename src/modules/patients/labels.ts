import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, SENSITIVE_LABELS, type Patient, type SensitiveLabel } from './patients.js';

/**
 * #187: adds and removes a patient's sensitive labels (mtp, pcpndt, hiv, mental_health). 404 if there is no such
 * patient, 409 if it was merged into another, 422 if nothing changes or a label is both added and removed. The old
 * labels and the reason are kept in the patient's history.
 */
export async function changeLabels(
  db: Queryable,
  id: string,
  change: { add?: SensitiveLabel[]; remove?: SensitiveLabel[]; reason: string },
  by: string,
): Promise<{ patient: Patient; before: SensitiveLabel[] }> {
  const patient = await getPatient(db, id);
  const { rows } = await db.query('SELECT merged_into FROM patients WHERE id = $1', [id]);
  if (rows[0]?.merged_into != null) throw new AppError(409, 'merged', 'this patient was merged into another; change that one');
  const add = change.add ?? [];
  const remove = change.remove ?? [];
  if (add.some((l) => remove.includes(l))) throw new AppError(422, 'invalid_input', 'a label can be added or removed, not both');
  const labels = SENSITIVE_LABELS.filter((l) => (patient.labels.includes(l) || add.includes(l)) && !remove.includes(l));
  if (labels.length === patient.labels.length && labels.every((l) => patient.labels.includes(l))) {
    throw new AppError(422, 'invalid_input', 'nothing to change: those labels are already as asked');
  }
  await updateRecord(db, 'patients', { id, version: patient.version, by, reason: change.reason, set: { labels: JSON.stringify(labels) } });
  return { patient: await getPatient(db, id), before: patient.labels };
}
