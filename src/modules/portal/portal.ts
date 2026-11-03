import type { Queryable } from '../../db/migrate.js';
import type { Address } from '../reference/hospital.js';
import { getPatient, updatePatient, type Patient } from '../patients/patients.js';
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
