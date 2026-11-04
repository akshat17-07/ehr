import type { Queryable } from '../db/migrate.js';
import { pcpndtMonthly } from '../modules/compliance/registers.js';
import { usersWithPermission } from '../permissions/check.js';
import { indiaDate } from '../time/india.js';
import { logSummary, raiseIfChanged, type JobDeps, type Tally } from './alert-digest.js';
import { recordRun } from './job-runs.js';

const JOB = 'pcpndt_monthly';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The India-time month before `now`, as YYYY-MM (January gives the previous December). */
export function previousMonth(now: Date): string {
  const [y, m] = indiaDate(now).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const record = (db: Queryable, startedAt: Date, ok: boolean, detail: Record<string, unknown>) =>
  recordRun(db, { job: JOB, startedAt, ok, detail });

/**
 * #505: on the 3rd of the month, tells everyone who holds compliance.registers that last month's PCPNDT report (Forms F)
 * is ready; it is due to the Appropriate Authority by the 5th. A month with no forms still alerts (a nil report is filed).
 * The alert text has the count only: no patient names, and there is no fetal-sex field anywhere.
 * The alert is English only (alerts have no Hindi text field).
 */
export async function pcpndtMonthlyJob({ db, now = new Date() }: JobDeps): Promise<void> {
  const startedAt = new Date();
  const tally: Tally = { alertsCreated: 0, skippedUnchanged: 0 };
  const month = previousMonth(now);
  try {
    const forms = (await pcpndtMonthly(db, month)).rows.length;
    const title = `PCPNDT monthly report for ${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)} is ready`;
    const body = `${forms} Form${forms === 1 ? '' : 's'} F (due to the Appropriate Authority by the 5th)`;
    for (const userId of await usersWithPermission(db, 'compliance.registers', now)) {
      await raiseIfChanged(db, userId, { kind: 'compliance', title, body, link: `/admin/registers/pcpndt-monthly?month=${month}` }, JOB, tally);
    }
    await record(db, startedAt, true, { month, forms, alertsCreated: tally.alertsCreated });
    logSummary(JOB, tally);
  } catch (err) {
    await record(db, startedAt, false, { error: err instanceof Error ? err.message : String(err), month });
    throw err;
  }
}
