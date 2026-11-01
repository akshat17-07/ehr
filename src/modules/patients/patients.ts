import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import type { Address } from '../reference/hospital.js';

// Patients (api-list.md Patient). Every patient has a UHID, e.g. U26000123: "U", the 2-digit year of registration
// and a 6-digit number, so it can't be taken for a 10-digit mobile number. A patient merged into another (#181)
// keeps their row, with merged_into set, and is left out of searches.

export const SEXES = ['M', 'F', 'O'] as const;
export type Sex = (typeof SEXES)[number];
export const SENSITIVE_LABELS = ['mtp', 'pcpndt', 'hiv', 'mental_health'] as const;
export type SensitiveLabel = (typeof SENSITIVE_LABELS)[number];

export const UHID = /^U\d{8}$/i;

/** Days without activity after which a patient is inactive. Per role or user once #185/#186 are built. */
export const INACTIVE_AFTER_DAYS = 10;

export interface Patient {
  id: string;
  version: number;
  uhid: string;
  name: string;
  sex: Sex;
  /** YYYY-MM-DD */
  dob?: string;
  /** From dob, or from the age given at registration, counted on to today. */
  ageYears?: number;
  mobile?: string;
  email?: string;
  address?: Address;
  unknown: boolean;
  labels: SensitiveLabel[];
  lastActivityAt?: string;
  inactive: boolean;
  allergies: string[];
  activePolicyId?: string;
}

/** What a search shows: no labels, address or allergies. */
export type PatientSummary = Pick<Patient, 'id' | 'uhid' | 'name' | 'sex' | 'dob' | 'ageYears' | 'mobile' | 'unknown' | 'inactive'>;

// Dates as text, so no time zone can move them a day.
export const PATIENT_SELECT = 'SELECT patients.*, dob::text AS dob_text, age_recorded_on::text AS age_recorded_on_text FROM patients';

const opt = (v: unknown) => (v == null ? undefined : String(v));

/** Whole years from `from` (YYYY-MM-DD) to `to`. */
export function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

function ageOf(r: Record<string, unknown>, today: string): number | undefined {
  if (r.dob_text != null) return yearsBetween(String(r.dob_text), today);
  if (r.age_years == null) return undefined;
  return Number(r.age_years) + yearsBetween(String(r.age_recorded_on_text), today);
}

export function toPatient(r: Record<string, unknown>, now = new Date()): Patient {
  const lastActivity = r.last_activity_at instanceof Date ? r.last_activity_at : undefined;
  const patient: Patient = {
    id: String(r.id),
    version: Number(r.version),
    uhid: String(r.uhid),
    name: String(r.name),
    sex: r.sex as Sex,
    dob: opt(r.dob_text),
    ageYears: ageOf(r, indiaDate(now)),
    mobile: opt(r.mobile),
    email: opt(r.email),
    address: r.address == null ? undefined : (JSON.parse(String(r.address)) as Address),
    unknown: r.unknown === true,
    labels: JSON.parse(String(r.labels)) as SensitiveLabel[],
    lastActivityAt: lastActivity?.toISOString(),
    inactive: !lastActivity || now.getTime() - lastActivity.getTime() > INACTIVE_AFTER_DAYS * 86_400_000,
    allergies: JSON.parse(String(r.allergies)) as string[],
    activePolicyId: opt(r.active_policy_id),
  };
  for (const key of Object.keys(patient) as (keyof Patient)[]) if (patient[key] === undefined) delete patient[key];
  return patient;
}

export function toSummary(p: Patient): PatientSummary {
  const { id, uhid, name, sex, dob, ageYears, mobile, unknown, inactive } = p;
  const summary: PatientSummary = { id, uhid, name, sex, dob, ageYears, mobile, unknown, inactive };
  for (const key of Object.keys(summary) as (keyof PatientSummary)[]) if (summary[key] === undefined) delete summary[key];
  return summary;
}

/** A 10-digit Indian mobile number from what was typed (+91, a leading 0, spaces and dashes dropped), or undefined. */
export function mobileOf(text: string): string | undefined {
  const digits = text.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : undefined;
}

/**
 * #19: by UHID, by 10-digit mobile (a family can share one) or by the start of the name (at least 2 letters).
 * name_search is the name in lower case, kept for this search.
 */
export async function searchPatients(db: Queryable, search: { q: string } & PageQuery, now = new Date()): Promise<Page<PatientSummary>> {
  const q = search.q.trim();
  const mobile = mobileOf(q);
  let where: string;
  let value: string;
  if (UHID.test(q)) [where, value] = ['uhid = $1', q.toUpperCase()];
  else if (mobile) [where, value] = ['mobile = $1', mobile];
  else if (q.length >= 2) [where, value] = ['name_search LIKE $1', `${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`];
  else throw new AppError(422, 'invalid_input', 'type a UHID, a 10-digit mobile number or at least 2 letters of the name');

  const page = await pageRows(
    db,
    { select: PATIENT_SELECT, where: [where, 'merged_into IS NULL'], params: [value], orderBy: ['name_search', 'id'], direction: 'asc' },
    search,
    (r) => toSummary(toPatient(r, now)),
  );
  return page;
}
