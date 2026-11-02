import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { assertOpen, getEncounter } from '../encounters/encounters.js';
import type { BaseFields } from '../patients/patients.js';
import { assertAlertsCleared, checkLines, type RxLine } from './rx-checks.js';

// Prescriptions (api-list.md Prescription). Typed ones are confirmed when saved (#62). An uploaded one (#63) stays a
// draft until the doctor confirms its lines (#64): until then it is not dispensed and not used in checks.

export const RX_SOURCES = ['typed', 'uploaded'] as const;
export type RxSource = (typeof RX_SOURCES)[number];
export const RX_STATUSES = ['draft', 'confirmed', 'dispensed', 'void'] as const;
export type RxStatus = (typeof RX_STATUSES)[number];

export interface Prescription extends Omit<BaseFields, 'status'> {
  status: RxStatus;
  encounterId: string;
  patientId: string;
  doctorId: string;
  source: RxSource;
  documentId?: string;
  lines: RxLine[];
  /** The warnings the doctor saw and went ahead with. */
  acknowledgedAlerts: string[];
  confirmedAt?: string;
  confirmedBy?: string;
}

export function toPrescription(r: Record<string, unknown>): Prescription {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as RxStatus,
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    doctorId: String(r.doctor_id),
    source: r.source as RxSource,
    ...(r.document_id != null && { documentId: String(r.document_id) }),
    lines: JSON.parse(String(r.lines)) as RxLine[],
    acknowledgedAlerts: r.acknowledged_alerts == null ? [] : (JSON.parse(String(r.acknowledged_alerts)) as string[]),
    ...(r.confirmed_at != null && { confirmedAt: (r.confirmed_at as Date).toISOString() }),
    ...(r.confirmed_by != null && { confirmedBy: String(r.confirmed_by) }),
  };
}

/** The users row of the signed-in prescriber (every staff request has one). */
export async function prescriberId(db: Queryable, sub: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub]);
  return String(rows[0]?.id);
}

export interface NewPrescription {
  lines: RxLine[];
  acknowledgedAlerts?: string[];
}

/** #62: runs the checks (409 rx_alerts unless cleared), then saves it confirmed. Only in an open encounter. */
export async function writePrescription(db: Queryable, encounterId: string, input: NewPrescription, by: string, now = new Date()): Promise<Prescription> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const acknowledged = input.acknowledgedAlerts ?? [];
  assertAlertsCleared(await checkLines(db, encounter.patientId, input.lines), acknowledged);
  const { rows } = await db.query(
    `INSERT INTO prescriptions (id, status, created_by, updated_by, encounter_id, patient_id, doctor_id, source, lines,
       acknowledged_alerts, confirmed_at, confirmed_by)
     VALUES ($1, 'confirmed', $2, $2, $3, $4, $5, 'typed', $6, $7, $8, $2) RETURNING *`,
    [
      randomUUID(), by, encounter.id, encounter.patientId, await prescriberId(db, by),
      JSON.stringify(input.lines), JSON.stringify(acknowledged), now,
    ],
  );
  return toPrescription(rows[0] as Record<string, unknown>);
}

/** The prescriptions of one encounter, oldest first (for #38); voided ones are left out. */
export async function encounterPrescriptions(db: Queryable, encounterId: string): Promise<Prescription[]> {
  const { rows } = await db.query('SELECT * FROM prescriptions WHERE encounter_id = $1 AND voided_at IS NULL ORDER BY created_at, id', [
    encounterId,
  ]);
  return rows.map(toPrescription);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** #66: 404 if there is none. */
export async function getPrescription(db: Queryable, id: string): Promise<Prescription> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM prescriptions WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such prescription');
  return toPrescription(rows[0] as Record<string, unknown>);
}

export interface PrescriptionQuery extends PageQuery {
  status?: RxStatus;
  /** India dates (YYYY-MM-DD), both days included. */
  from?: string;
  to?: string;
}

/** #67: newest first; voided ones are listed too (status void, with the reason). */
export async function patientPrescriptions(db: Queryable, patientId: string, query: PrescriptionQuery): Promise<Page<Prescription>> {
  const params: unknown[] = [patientId];
  const where = ['patient_id = $1'];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.from) where.push(`created_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`created_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: 'SELECT * FROM prescriptions', where, params, orderBy: ['created_at', 'id'] }, query, toPrescription);
}
