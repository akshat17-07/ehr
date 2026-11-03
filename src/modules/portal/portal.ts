import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import type { Address } from '../reference/hospital.js';
import { getPatient, updatePatient, type Patient } from '../patients/patients.js';
import { toEncounter, type EncounterStatus, type EncounterType } from '../encounters/encounters.js';
import { encounterVitals, VITAL_FIELDS, type Vital } from '../encounters/vitals.js';
import { toPrescription, type Prescription, type RxSource, type RxStatus } from '../prescriptions/prescriptions.js';
import type { RxLine } from '../prescriptions/rx-checks.js';
import { toAppointment } from '../appointments/appointments.js';
import { toSurgery } from '../surgeries/surgeries.js';

// Patient-portal views (api-list.md §8, #239-#241). The caller has been resolved by resolvePortalPatient; these
// functions only shape what a patient may see: no staff-only fields (who saved what, sensitive labels, staff notes,
// emergency notes, checklists, op notes, team) and never a venue payment.

/** The patient's own details as the portal shows them. */
export interface PortalPatient {
  id: string;
  version: number;
  uhid: string;
  name: string;
  sex: Patient['sex'];
  dob?: string;
  ageYears?: number;
  mobile?: string;
  email?: string;
  address?: Address;
  allergies: string[];
  updatedAt: string;
}

export function toPortalPatient(p: Patient): PortalPatient {
  return {
    id: p.id,
    version: p.version,
    uhid: p.uhid,
    name: p.name,
    sex: p.sex,
    ...(p.dob !== undefined && { dob: p.dob }),
    ...(p.ageYears !== undefined && { ageYears: p.ageYears }),
    ...(p.mobile !== undefined && { mobile: p.mobile }),
    ...(p.email !== undefined && { email: p.email }),
    ...(p.address !== undefined && { address: p.address }),
    allergies: p.allergies,
    updatedAt: p.updatedAt,
  };
}

/** #240: contact details only; name and DOB corrections go through the staff (#258). null clears a field. */
export interface PortalProfileChange {
  version: number;
  mobile?: string | null;
  email?: string | null;
  address?: Address | null;
}

export async function updatePortalProfile(db: Queryable, patientId: string, change: PortalProfileChange, by: string): Promise<PortalPatient> {
  const { version, mobile, email, address } = change;
  const patient = await updatePatient(db, patientId, { version, mobile, email, address, reason: 'patient portal' }, by);
  return toPortalPatient(patient);
}

export async function portalPatient(db: Queryable, patientId: string): Promise<PortalPatient> {
  return toPortalPatient(await getPatient(db, patientId));
}

export interface PortalAppointment {
  id: string;
  status: string;
  patientId: string;
  at: string;
  durationMin: number;
  doctorId: string;
  doctorName?: string;
  departmentId: string;
  departmentName?: string;
}

export interface PortalSurgery {
  id: string;
  status: string;
  patientId: string;
  procedure: string;
  site?: string;
  side?: string;
  scheduledAt: string;
  venue: string;
  hospitalName?: string;
  surgeonId: string;
  surgeonName?: string;
  /** The estimate charged to the patient. What we pay a partner venue is never shown. */
  chargesPaise: number;
  instructions?: string;
}

export interface PortalHome {
  nextAppointment?: PortalAppointment;
  nextSurgery?: PortalSurgery;
  /** Owed on finalised bills (final, part paid). Drafts and voided bills don't count. */
  duePaise: number;
  /** There is no patient notification store yet, so always 0. */
  unreadCount: number;
}

const opt = (v: unknown) => (v == null ? undefined : String(v));

/** #241 */
export async function portalHome(db: Queryable, patientId: string, now = new Date()): Promise<PortalHome> {
  const appt = await db.query(
    `SELECT a.*, u.name AS doctor_name, d.name_en AS department_name FROM appointments a
     LEFT JOIN users u ON u.id = a.doctor_id LEFT JOIN departments d ON d.id = a.department_id
     WHERE a.patient_id = $1 AND a.status = 'booked' AND a.voided_at IS NULL AND a.at >= $2 ORDER BY a.at, a.id LIMIT 1`,
    [patientId, now],
  );
  const surgery = await db.query(
    `SELECT s.*, u.name AS surgeon_name, h.name AS hospital_name FROM surgeries s
     LEFT JOIN users u ON u.id = s.surgeon_id LEFT JOIN partner_hospitals h ON h.id = s.partner_hospital_id
     WHERE s.patient_id = $1 AND s.status = 'scheduled' AND s.voided_at IS NULL AND s.scheduled_at >= $2
     ORDER BY s.scheduled_at, s.id LIMIT 1`,
    [patientId, now],
  );
  const due = await db.query(
    `SELECT COALESCE(SUM(total_paise - paid_paise), 0) AS due FROM bills
     WHERE patient_id = $1 AND status IN ('final', 'part_paid') AND voided_at IS NULL`,
    [patientId],
  );

  const home: PortalHome = { duePaise: Number(due.rows[0]?.due ?? 0), unreadCount: 0 };
  const ar = appt.rows[0] as Record<string, unknown> | undefined;
  if (ar) {
    const a = toAppointment(ar, now);
    home.nextAppointment = {
      id: a.id, status: a.status, patientId: a.patientId, at: a.at, durationMin: a.durationMin,
      doctorId: a.doctorId, ...(opt(ar.doctor_name) && { doctorName: String(ar.doctor_name) }),
      departmentId: a.departmentId, ...(opt(ar.department_name) && { departmentName: String(ar.department_name) }),
    };
  }
  const sr = surgery.rows[0] as Record<string, unknown> | undefined;
  if (sr) {
    const s = toSurgery(sr);
    home.nextSurgery = {
      id: s.id, status: s.status, patientId: s.patientId, procedure: s.procedure,
      ...(s.site !== undefined && { site: s.site }), ...(s.side !== undefined && { side: s.side }),
      scheduledAt: s.scheduledAt, venue: s.venue, ...(opt(sr.hospital_name) && { hospitalName: String(sr.hospital_name) }),
      surgeonId: s.surgeonId, ...(opt(sr.surgeon_name) && { surgeonName: String(sr.surgeon_name) }),
      chargesPaise: s.chargesPaise, ...(s.instructions !== undefined && { instructions: s.instructions }),
    };
  }
  return home;
}

// #242-#244: visits and prescriptions for the portal. Drafts, voided items and staff-only fields never leave here.
// A patient with any sensitive label (#187) gets no diagnoses, notes or prescriptions through the portal: those are
// where a labelled condition or drug would show. The visit summary has no clinical content, so it is always shown.

export interface PortalVisitSummary {
  id: string;
  status: EncounterStatus;
  patientId: string;
  type: EncounterType;
  departmentId: string;
  doctorId: string;
  startedAt: string;
  closedAt?: string;
}

export type PortalVital = { id: string; takenAt: string } & Partial<Record<(typeof VITAL_FIELDS)[number][0], number>>;

export interface PortalDiagnosis {
  id: string;
  icd10: string;
  text: string;
}

export interface PortalNote {
  id: string;
  kind: 'progress' | 'consult' | 'procedure';
  text: string;
  signedAt: string;
  addenda: { text: string; at: string }[];
}

export interface PortalPrescription {
  id: string;
  status: Exclude<RxStatus, 'draft' | 'void'>;
  source: RxSource;
  createdAt: string;
  lines: RxLine[];
  confirmedAt?: string;
}

export interface PortalVisitDetail extends PortalVisitSummary {
  vitals: PortalVital[];
  diagnoses: PortalDiagnosis[];
  notes: PortalNote[];
  prescriptions: PortalPrescription[];
}

export const PORTAL_PRESCRIPTION_STATUSES = ['confirmed', 'dispensed'] as const;

/** Any sensitive label on the patient hides its clinical narrative and drugs from the portal. */
export async function hasSensitiveLabel(db: Queryable, patientId: string): Promise<boolean> {
  return (await getPatient(db, patientId)).labels.length > 0;
}

export function toPortalVisit(r: Record<string, unknown>): PortalVisitSummary {
  const e = toEncounter(r);
  return {
    id: e.id,
    status: e.status,
    patientId: e.patientId,
    type: e.type,
    departmentId: e.departmentId,
    doctorId: e.doctorId,
    startedAt: e.startedAt,
    ...(e.closedAt !== undefined && { closedAt: e.closedAt }),
  };
}

/** #242: the patient's visits, newest first. */
export async function portalVisits(db: Queryable, patientId: string, query: PageQuery): Promise<Page<PortalVisitSummary>> {
  return pageRows(
    db,
    { select: 'SELECT * FROM encounters', where: ['patient_id = $1', 'voided_at IS NULL'], params: [patientId], orderBy: ['started_at', 'id'] },
    query,
    toPortalVisit,
  );
}

const portalVital = (v: Vital): PortalVital => {
  const out: PortalVital = { id: v.id, takenAt: v.takenAt };
  for (const [field] of VITAL_FIELDS) if (v[field] !== undefined) out[field] = v[field];
  return out;
};

export function toPortalPrescription(p: Prescription): PortalPrescription {
  return {
    id: p.id,
    status: p.status as PortalPrescription['status'],
    source: p.source,
    createdAt: p.createdAt,
    lines: p.lines,
    ...(p.confirmedAt !== undefined && { confirmedAt: p.confirmedAt }),
  };
}

/** #243: one visit. The caller has checked that the visit's patient is one this account may act for. */
export async function portalVisitDetail(db: Queryable, encounterId: string): Promise<PortalVisitDetail> {
  const { rows } = await db.query('SELECT * FROM encounters WHERE id = $1 AND voided_at IS NULL', [encounterId]);
  if (!rows[0]) throw new AppError(403, 'forbidden', 'not a patient this account may see');
  const visit = toPortalVisit(rows[0] as Record<string, unknown>);
  const vitals = (await encounterVitals(db, encounterId)).map(portalVital);
  if (await hasSensitiveLabel(db, visit.patientId)) return { ...visit, vitals, diagnoses: [], notes: [], prescriptions: [] };

  const diagnoses = await db.query(
    "SELECT id, icd10, text FROM diagnoses WHERE encounter_id = $1 AND kind = 'final' AND voided_at IS NULL ORDER BY created_at, id",
    [encounterId],
  );
  const notes = await db.query(
    "SELECT * FROM notes WHERE encounter_id = $1 AND status = 'signed' AND kind <> 'nursing' AND voided_at IS NULL ORDER BY created_at, id",
    [encounterId],
  );
  const rx = await db.query(
    `SELECT * FROM prescriptions WHERE encounter_id = $1 AND status IN ($2, $3) AND voided_at IS NULL ORDER BY created_at, id`,
    [encounterId, ...PORTAL_PRESCRIPTION_STATUSES],
  );
  return {
    ...visit,
    vitals,
    diagnoses: diagnoses.rows.map((r) => ({ id: String(r.id), icd10: String(r.icd10), text: String(r.text) })),
    notes: notes.rows.map((r) => {
      const addenda = JSON.parse(String(r.addenda ?? '[]')) as { text: string; at: string }[];
      return {
        id: String(r.id),
        kind: r.kind as PortalNote['kind'],
        text: String(r.text),
        signedAt: (r.signed_at as Date).toISOString(),
        addenda: addenda.map((a) => ({ text: a.text, at: a.at })),
      };
    }),
    prescriptions: rx.rows.map((r) => toPortalPrescription(toPrescription(r as Record<string, unknown>))),
  };
}

/** #244: the patient's prescriptions that were issued (confirmed or dispensed), newest first. */
export async function portalPrescriptions(db: Queryable, patientId: string, query: PageQuery): Promise<Page<PortalPrescription>> {
  return pageRows(
    db,
    {
      select: 'SELECT * FROM prescriptions',
      where: ['patient_id = $1', "status IN ('confirmed', 'dispensed')", 'voided_at IS NULL'],
      params: [patientId],
      orderBy: ['created_at', 'id'],
    },
    query,
    (r) => toPortalPrescription(toPrescription(r)),
  );
}
