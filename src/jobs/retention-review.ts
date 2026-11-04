import type { Queryable } from '../db/migrate.js';
import { usersWithPermission } from '../permissions/check.js';
import { indiaDate, indiaDayStart } from '../time/india.js';
import { logSummary, raiseIfChanged, type JobDeps, type Tally } from './alert-digest.js';
import { recordRun } from './job-runs.js';

const JOB = 'retention_review';

/** Defaults from docs/india/compliance-plan.md section 7 (legal to confirm). */
export const RETENTION = { patientYears: 10, minorAge: 24, billYears: 8 } as const;
/** MTP and PC-PNDT records are kept permanently. */
const PERMANENT_LABELS = ['mtp', 'pcpndt'];

const yearsBefore = (date: string, years: number) => `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;
const ACTIVE_HOLD = (patient: string) =>
  `EXISTS (SELECT 1 FROM legal_holds h WHERE h.patient_id = ${patient} AND h.status = 'active' AND h.released_at IS NULL AND h.voided_at IS NULL)`;

export interface RetentionCounts {
  patients: number;
  bills: number;
  onHold: number;
  permanent: number;
}

/** Counts only: nothing is changed. */
export async function retentionCounts(db: Queryable, now: Date): Promise<RetentionCounts> {
  const today = indiaDate(now);
  const patientCutoff = indiaDayStart(yearsBefore(today, RETENTION.patientYears));
  const billCutoff = indiaDayStart(yearsBefore(today, RETENTION.billYears));
  const counts: RetentionCounts = { patients: 0, bills: 0, onHold: 0, permanent: 0 };

  const { rows: patients } = await db.query(
    `SELECT p.labels, p.dob::text AS dob, p.age_years, p.created_at, ${ACTIVE_HOLD('p.id')} AS held FROM patients p
     WHERE p.voided_at IS NULL AND COALESCE(p.last_activity_at, p.created_at) < $1`,
    [patientCutoff],
  );
  const adultDob = yearsBefore(today, RETENTION.minorAge);
  for (const p of patients) {
    // A minor (under 24 now, the 21+3 rule) is not due. With no dob, estimate the birth year from the age given at
    // registration; with neither, only the activity date counts.
    if (p.dob != null ? String(p.dob) > adultDob : p.age_years != null && Number(indiaDate(p.created_at as Date).slice(0, 4)) - Number(p.age_years) > Number(adultDob.slice(0, 4))) continue;
    const labels = JSON.parse(String(p.labels)) as string[];
    if (labels.some((l) => PERMANENT_LABELS.includes(l))) counts.permanent++;
    else if (p.held) counts.onHold++;
    else counts.patients++;
  }

  const { rows: bills } = await db.query(
    `SELECT ${ACTIVE_HOLD('b.patient_id')} AS held FROM bills b
     WHERE b.voided_at IS NULL AND b.status IN ('final', 'paid', 'part_paid') AND COALESCE(b.finalised_at, b.created_at) < $1`,
    [billCutoff],
  );
  for (const b of bills) {
    if (b.held) counts.onHold++;
    else counts.bills++;
  }
  return counts;
}

/**
 * #506: monthly REPORT ONLY of what is past its retention period. It never deletes, voids or changes a record.
 * Deleting needs the Admin-approved batch flow (compliance-plan sections 3A and 7), which is not built yet.
 * Alerts go to settings.view holders, and only when something is due; an unchanged count is not alerted again.
 */
export async function retentionReview({ db, now = new Date() }: JobDeps): Promise<void> {
  const startedAt = new Date();
  const tally: Tally = { alertsCreated: 0, skippedUnchanged: 0 };
  const record = (ok: boolean, detail: Record<string, unknown>) => recordRun(db as Queryable, { job: JOB, startedAt, ok, detail });
  try {
    const counts = await retentionCounts(db, now);
    if (counts.patients > 0 || counts.bills > 0) {
      const body = `${counts.patients} patient records and ${counts.bills} bills are past the retention period. Nothing is deleted automatically.`;
      for (const userId of await usersWithPermission(db, 'settings.view', now)) {
        await raiseIfChanged(db, userId, { kind: 'compliance', title: 'Retention review', body, link: '/admin/compliance' }, JOB, tally);
      }
    }
    await record(true, { ...counts });
    logSummary(JOB, tally);
  } catch (err) {
    await record(false, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
