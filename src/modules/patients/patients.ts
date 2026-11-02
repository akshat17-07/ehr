import { assertReferrer } from '../referrals/referrers.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nextCount } from '../../db/counters.js';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { dateText, listVersions, updateRecord, type Version } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import type { Address } from '../reference/hospital.js';

// Patients (api-list.md Patient). Every patient has a UHID, e.g. U26000123: "U", the 2-digit year of registration
// and a 6-digit number counted per year, so it can't be taken for a 10-digit mobile number. A patient merged into
// another (#181) keeps their row, with merged_into set, and is left out of searches.

export const SEXES = ['M', 'F', 'O'] as const;
export type Sex = (typeof SEXES)[number];
export const SENSITIVE_LABELS = ['mtp', 'pcpndt', 'hiv', 'mental_health'] as const;
export type SensitiveLabel = (typeof SENSITIVE_LABELS)[number];

export const UHID = /^U\d{8,}$/i;

/** Days without activity after which a patient is inactive. Per role or user once #185/#186 are built. */
export const INACTIVE_AFTER_DAYS = 10;

export type BaseFields = ReturnType<typeof baseFields>;

export interface Patient extends BaseFields {
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
  /** Who sent the patient (#141). */
  referrerId?: string;
  /** Unknown emergency patients (#21): what they look like, and who brought them in. */
  emergencyNote?: string;
  broughtBy?: string;
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
    ...baseFields(r as unknown as BaseRow),
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
    referrerId: opt(r.referrer_id),
    emergencyNote: opt(r.emergency_note),
    broughtBy: opt(r.brought_by),
  };
  for (const key of Object.keys(patient) as (keyof Patient)[]) if (patient[key] === undefined) delete patient[key];
  return patient;
}

/** The summaries of the patients `ids`, by id (one query for a whole list). */
export async function patientSummaries(db: Queryable, ids: string[], now = new Date()): Promise<Map<string, PatientSummary>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query(`${PATIENT_SELECT} WHERE id IN (${unique.map((_, i) => `$${i + 1}`).join(', ')})`, unique);
  return new Map(rows.map((p) => [String(p.id), toSummary(toPatient(p, now))]));
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

const notFound = () => new AppError(404, 'not_found', 'no such patient');

export async function getPatient(db: Queryable, id: string, now = new Date()): Promise<Patient> {
  if (!z.uuid().safeParse(id).success) throw notFound();
  const { rows } = await db.query(`${PATIENT_SELECT} WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return toPatient(rows[0], now);
}

/** #20. Either dob or ageYears. */
export interface NewPatient {
  name: string;
  sex: Sex;
  dob?: string;
  ageYears?: number;
  mobile?: string;
  email?: string;
  address?: Address;
  /** Added with the patient; more with #26. */
  guardian?: { name: string; relation: string; mobile?: string };
  /** Who sent the patient (#141). */
  referrerId?: string;
}

const MAX_UHID_TRIES = 5;

/** The next free UHID of this year. Skips a number already used (e.g. by patients loaded from an old system). */
async function insertWithUhid(db: Queryable, now: Date, insert: (uhid: string) => Promise<void>): Promise<void> {
  const year = indiaDate(now).slice(2, 4);
  for (let attempt = 1; ; attempt++) {
    const uhid = `U${year}${String(await nextCount(db, `uhid-${year}`)).padStart(6, '0')}`;
    try {
      return await insert(uhid);
    } catch (error) {
      const taken = (error as { code?: string; constraint?: string }).code === '23505';
      if (!taken || attempt >= MAX_UHID_TRIES) throw error;
    }
  }
}

interface PatientRow {
  name: string;
  sex: Sex;
  dob?: string;
  ageYears?: number;
  mobile?: string;
  email?: string;
  address?: Address;
  unknown?: boolean;
  emergencyNote?: string;
  broughtBy?: string;
  referrerId?: string;
}

/**
 * Adds the patient row (and `more`, in the same transaction) under the year's next UHID. Registering counts as
 * activity, so the patient starts active.
 */
async function addPatient(
  db: Queryable,
  row: PatientRow,
  by: string,
  now: Date,
  more?: (tx: Queryable, id: string) => Promise<void>,
): Promise<Patient> {
  const id = randomUUID();
  await insertWithUhid(db, now, (uhid) =>
    withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, dob, age_years, age_recorded_on,
           mobile, email, address, unknown, emergency_note, brought_by, labels, allergies, last_activity_at, referrer_id)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '[]', '[]', $16, $17)`,
        [
          id, by, uhid, row.name, row.name.toLowerCase(), row.sex, row.dob ?? null, row.ageYears ?? null,
          row.ageYears === undefined ? null : indiaDate(now), row.mobile ?? null, row.email ?? null,
          row.address ? JSON.stringify(row.address) : null, row.unknown ?? false, row.emergencyNote ?? null,
          row.broughtBy ?? null, now, row.referrerId ?? null,
        ],
      );
      await more?.(tx, id);
    }),
  );
  return getPatient(db, id, now);
}

/** #20: a new patient with a new UHID, and their guardian if given. */
export async function registerPatient(db: Queryable, input: NewPatient, by: string, now = new Date()): Promise<Patient> {
  const { guardian, ...row } = input;
  if (row.referrerId) await assertReferrer(db, row.referrerId);
  return addPatient(db, row, by, now, async (tx, id) => {
    if (!guardian) return;
    await tx.query(
      `INSERT INTO guardians (id, status, created_by, updated_by, patient_id, name, relation, mobile)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6)`,
      [randomUUID(), by, id, guardian.name, guardian.relation, guardian.mobile ?? null],
    );
  });
}

export interface EmergencyPatient {
  /** O when not known. */
  sex?: Sex;
  approxAgeYears?: number;
  description: string;
  broughtBy?: string;
}

/**
 * #21: a patient who can't give their name (unconscious, alone) gets a UHID at once, named "Unknown-<n>", so care
 * and billing can start. The real details are filled in later with PATCH (#23, `unknown: false`).
 */
export async function registerEmergency(db: Queryable, input: EmergencyPatient, by: string, now = new Date()): Promise<Patient> {
  const n = await nextCount(db, 'unknown-patient');
  return addPatient(
    db,
    {
      name: `Unknown-${n}`,
      sex: input.sex ?? 'O',
      ageYears: input.approxAgeYears,
      unknown: true,
      emergencyNote: input.description,
      broughtBy: input.broughtBy,
    },
    by,
    now,
  );
}

/** #23. null clears mobile, email or address. dob and ageYears replace each other. */
export interface PatientChange {
  version: number;
  name?: string;
  sex?: Sex;
  dob?: string;
  ageYears?: number;
  mobile?: string | null;
  email?: string | null;
  address?: Address | null;
  /** Only false: an unknown emergency patient has been identified (give their name in the same edit). */
  unknown?: false;
  reason?: string;
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);

/** #23: edits the patient's details; the old version is kept (#24). A merged patient can't be edited. */
export async function updatePatient(db: Queryable, id: string, change: PatientChange, by: string, now = new Date()): Promise<Patient> {
  await getPatient(db, id, now);
  const { rows } = await db.query('SELECT merged_into FROM patients WHERE id = $1', [id]);
  if (rows[0]?.merged_into != null) throw new AppError(409, 'merged', 'this patient was merged into another; edit that one');
  if (change.unknown === false && change.name === undefined) throw invalid('give the name of the identified patient');

  const set: Record<string, unknown> = {};
  if (change.name !== undefined) Object.assign(set, { name: change.name, name_search: change.name.toLowerCase() });
  if (change.sex !== undefined) set.sex = change.sex;
  if (change.dob !== undefined) Object.assign(set, { dob: change.dob, age_years: null, age_recorded_on: null });
  if (change.ageYears !== undefined) Object.assign(set, { dob: null, age_years: change.ageYears, age_recorded_on: indiaDate(now) });
  if (change.mobile !== undefined) set.mobile = change.mobile;
  if (change.email !== undefined) set.email = change.email;
  if (change.address !== undefined) set.address = change.address === null ? null : JSON.stringify(change.address);
  if (change.unknown === false) set.unknown = false;

  await updateRecord(db, 'patients', { id, version: change.version, by, set, reason: change.reason });
  return getPatient(db, id, now);
}

/** #24: every version of the patient, oldest first, with who changed it, when and why. */
export async function listPatientVersions(db: Queryable, id: string, now = new Date()): Promise<Version<Patient>[]> {
  if (!z.uuid().safeParse(id).success) throw notFound();
  return listVersions(db, 'patients', id, (row) =>
    toPatient({ ...row, dob_text: dateText(row.dob), age_recorded_on_text: dateText(row.age_recorded_on) }, now),
  );
}
