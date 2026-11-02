import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';

// Surgeries (api-list.md Surgery): planned here or at a partner hospital (then we pay the venue, #92).

export const SURGERY_STATUSES = ['scheduled', 'done', 'cancelled'] as const;
export type SurgeryStatus = (typeof SURGERY_STATUSES)[number];
export const SIDES = ['left', 'right', 'bilateral', 'na'] as const;
export const VENUES = ['own', 'partner'] as const;

export interface Surgery extends Omit<BaseFields, 'status'> {
  status: SurgeryStatus;
  patientId: string;
  procedure: string;
  site?: string;
  side?: (typeof SIDES)[number];
  surgeonId: string;
  teamIds: string[];
  scheduledAt: string;
  venue: (typeof VENUES)[number];
  partnerHospitalId?: string;
  chargesPaise: number;
  consentDocumentIds: string[];
  instructions?: string;
  checklist?: Record<string, unknown>;
  opNote?: Record<string, unknown>;
  /** On lists. */
  patient?: PatientSummary;
}

export function toSurgery(r: Record<string, unknown>): Surgery {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as SurgeryStatus,
    patientId: String(r.patient_id),
    procedure: String(r.procedure),
    ...(r.site != null && { site: String(r.site) }),
    ...(r.side != null && { side: r.side as Surgery['side'] }),
    surgeonId: String(r.surgeon_id),
    teamIds: JSON.parse(String(r.team_ids)) as string[],
    scheduledAt: (r.scheduled_at as Date).toISOString(),
    venue: r.venue as Surgery['venue'],
    ...(r.partner_hospital_id != null && { partnerHospitalId: String(r.partner_hospital_id) }),
    chargesPaise: Number(r.charges_paise),
    consentDocumentIds: JSON.parse(String(r.consent_document_ids)) as string[],
    ...(r.instructions != null && { instructions: String(r.instructions) }),
    ...(r.checklist != null && { checklist: JSON.parse(String(r.checklist)) as Record<string, unknown> }),
    ...(r.op_note != null && { opNote: JSON.parse(String(r.op_note)) as Record<string, unknown> }),
  };
}

export interface SurgeryQuery {
  /** Days, YYYY-MM-DD, both inclusive, India time. At most MAX_RANGE_DAYS apart. */
  from: string;
  to: string;
  surgeonId?: string;
  status?: SurgeryStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 92;

/** #86: the OT list, earliest first, each with the patient's summary. */
export async function listSurgeries(db: Queryable, query: SurgeryQuery, now = new Date()): Promise<Surgery[]> {
  const start = indiaDayStart(query.from);
  const end = new Date(indiaDayStart(query.to).getTime() + DAY_MS);
  if (end <= start) throw new AppError(422, 'invalid_input', 'to: on or after from');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new AppError(422, 'invalid_input', `at most ${MAX_RANGE_DAYS} days at a time`);
  const params: unknown[] = [start, end];
  const where = ['scheduled_at >= $1', 'scheduled_at < $2'];
  if (query.surgeonId) where.push(`surgeon_id = $${params.push(query.surgeonId)}`);
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  const { rows } = await db.query(`SELECT * FROM surgeries WHERE ${where.join(' AND ')} ORDER BY scheduled_at, id`, params);
  const surgeries = rows.map(toSurgery);
  const byId = await patientSummaries(db, surgeries.map((s) => s.patientId), now);
  return surgeries.map((s) => ({ ...s, patient: byId.get(s.patientId) }));
}
