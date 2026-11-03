import { getHospital } from '../modules/reference/hospital.js';
import { usersWithPermission } from '../permissions/check.js';
import { indiaDate, indiaDayStart } from '../time/india.js';
import { logSummary, raiseIfChanged, type JobDeps, type Tally } from './alert-digest.js';

const JOB = 'licence_check';
const DAY_MS = 86_400_000;
const HOSPITAL_DAYS = 90;
const DOCTOR_DAYS = 60;
const NAMES_SHOWN = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM-DD -> 05 Mar 2027 */
const pretty = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const daysBetween = (from: string, to: string) => Math.round((indiaDayStart(to).getTime() - indiaDayStart(from).getTime()) / DAY_MS);
const plus = (today: string, days: number) => indiaDate(new Date(indiaDayStart(today).getTime() + days * DAY_MS));

/** #503: nightly check of the hospital licence (to settings.manage users) and the doctors' council registrations. */
export async function licenceCheck({ db, now = new Date() }: JobDeps): Promise<void> {
  const today = indiaDate(now);
  const tally: Tally = { alertsCreated: 0, skippedUnchanged: 0 };
  const managers = await usersWithPermission(db, 'settings.manage', now);

  const hospital = await getHospital(db);
  let body: string | undefined;
  if (!hospital.licenceValidTill) body = 'Hospital licence valid-till date is not set';
  else if (hospital.licenceValidTill <= plus(today, HOSPITAL_DAYS)) {
    const days = daysBetween(today, hospital.licenceValidTill);
    const head = `Hospital licence (MP) ${hospital.mpLicenceNo} valid till ${pretty(hospital.licenceValidTill)}`;
    body = days >= 0 ? `${head}: expires in ${days} days` : `${head}: expired ${-days} days ago`;
  }
  if (body) {
    for (const userId of managers) {
      await raiseIfChanged(db, userId, { kind: 'licence', title: 'Hospital licence', body, link: '/settings/hospital' }, JOB, tally);
    }
  }

  const { rows } = await db.query(
    `SELECT cognito_sub, name, council_reg_no, reg_valid_till::text AS valid_till FROM users
     WHERE active = true AND voided_at IS NULL AND reg_valid_till IS NOT NULL AND reg_valid_till <= $1 ORDER BY reg_valid_till, name, id`,
    [plus(today, DOCTOR_DAYS)],
  );
  const doctors = rows.map((r) => ({ sub: String(r.cognito_sub), name: String(r.name), regNo: String(r.council_reg_no ?? ''), till: String(r.valid_till) }));
  if (doctors.length > 0) {
    const lines = doctors.slice(0, NAMES_SHOWN).map((d) => `${d.name} (${d.regNo}) ${pretty(d.till)}`);
    const more = doctors.length > NAMES_SHOWN ? `; and ${doctors.length - NAMES_SHOWN} more` : '';
    const body = `Registrations expired or expiring within ${DOCTOR_DAYS} days: ${lines.join('; ')}${more}`;
    for (const userId of managers) {
      await raiseIfChanged(db, userId, { kind: 'licence', title: 'Doctor registrations', body, link: '/settings/users' }, JOB, tally);
    }
    for (const d of doctors) {
      const own = `Your council registration ${d.regNo} is valid till ${pretty(d.till)}`;
      await raiseIfChanged(db, d.sub, { kind: 'licence', title: 'Your council registration', body: own }, JOB, tally);
    }
  }
  logSummary(JOB, tally);
}
