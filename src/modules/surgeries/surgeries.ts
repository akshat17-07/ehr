import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { getPatient, patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';

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

function invalid(message: string): never {
  throw new AppError(422, 'invalid_input', message);
}

/** 422 unless every id is an active user, of one of `types` if given. */
export async function assertActiveUsers(db: Queryable, field: string, ids: string[], types?: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const params: unknown[] = [...ids];
  const typeFilter = types ? ` AND type IN (${types.map((t) => `$${params.push(t)}`).join(', ')})` : '';
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) AND active${typeFilter}`,
    params,
  );
  if (rows.length !== new Set(ids).size) invalid(`${field}: each must be an active ${types ? types.join(' or ') : 'user'}`);
}

/** 422 unless the partner hospital is on the list. */
export async function assertPartnerHospital(db: Queryable, id: string): Promise<void> {
  const { rows } = await db.query('SELECT id FROM partner_hospitals WHERE id = $1 AND voided_at IS NULL', [id]);
  if (!rows[0]) invalid('partnerHospitalId: no such partner hospital');
}

export const SURGEONS = ['doctor', 'head_doctor'] as const;

export interface NewSurgery {
  patientId: string;
  procedure: string;
  site?: string;
  side?: Surgery['side'];
  surgeonId: string;
  teamIds?: string[];
  scheduledAt: Date;
  venue: Surgery['venue'];
  partnerHospitalId?: string;
  chargesPaise: number;
  instructions?: string;
}

/** An emergency done overnight can be entered next morning; nothing earlier, nor over a year ahead. */
const PAST_GRACE_MS = DAY_MS;
const MAX_AHEAD_MS = 365 * DAY_MS;

/** #87: a partner venue needs its hospital, and only then. The surgeon is not repeated in the team. */
export async function planSurgery(db: Queryable, input: NewSurgery, by: string, now = new Date()): Promise<Surgery> {
  if ((input.venue === 'partner') !== (input.partnerHospitalId !== undefined)) {
    invalid('partnerHospitalId: needed for a partner venue, and only then');
  }
  const at = input.scheduledAt.getTime();
  if (at < now.getTime() - PAST_GRACE_MS || at > now.getTime() + MAX_AHEAD_MS) invalid('scheduledAt: from yesterday to a year ahead');
  const patient = await getPatient(db, input.patientId, now);
  await assertActiveUsers(db, 'surgeonId', [input.surgeonId], SURGEONS);
  const teamIds = [...new Set(input.teamIds ?? [])].filter((id) => id !== input.surgeonId);
  await assertActiveUsers(db, 'teamIds', teamIds);
  if (input.partnerHospitalId) await assertPartnerHospital(db, input.partnerHospitalId);
  const { rows } = await db.query(
    `INSERT INTO surgeries (id, status, created_by, updated_by, patient_id, procedure, site, side, surgeon_id, team_ids, scheduled_at, venue,
       partner_hospital_id, charges_paise, consent_document_ids, instructions)
     VALUES ($1, 'scheduled', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]', $13) RETURNING *`,
    [
      randomUUID(), by, patient.id, input.procedure, input.site ?? null, input.side ?? null, input.surgeonId, JSON.stringify(teamIds),
      input.scheduledAt, input.venue, input.partnerHospitalId ?? null, input.chargesPaise, input.instructions ?? null,
    ],
  );
  return toSurgery(rows[0] as Record<string, unknown>);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One surgery; 404 if there is none. */
export async function getSurgery(db: Queryable, id: string): Promise<Surgery> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM surgeries WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such surgery');
  return toSurgery(rows[0] as Record<string, unknown>);
}

/** 409 for a cancelled surgery. */
export function assertNotCancelled(surgery: Surgery): void {
  if (surgery.status === 'cancelled') throw new AppError(409, 'cancelled', 'this surgery was cancelled');
}
