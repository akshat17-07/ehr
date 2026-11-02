import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord, voidRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { assertPatientDocuments } from '../documents/documents.js';
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

/**
 * #63: a paper prescription, photographed or scanned (the document is uploaded first, #94). It stays a draft, with
 * any lines typed from it so far, until a doctor confirms it (#64); only then do the alert checks run.
 */
export async function uploadPrescription(
  db: Queryable,
  encounterId: string,
  input: { documentId: string; lines?: RxLine[] },
  by: string,
): Promise<Prescription> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  await assertPatientDocuments(db, encounter.patientId, [input.documentId], 'documentId');
  const lines = input.lines ?? [];
  // Unknown or inactive drugs are refused now; the alerts wait for the confirm.
  if (lines.length > 0) await checkLines(db, encounter.patientId, lines);
  const { rows } = await db.query(
    `INSERT INTO prescriptions (id, status, created_by, updated_by, encounter_id, patient_id, doctor_id, source, document_id, lines,
       acknowledged_alerts)
     VALUES ($1, 'draft', $2, $2, $3, $4, $5, 'uploaded', $6, $7, '[]') RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, await prescriberId(db, by), input.documentId, JSON.stringify(lines)],
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

/** #68: a wrong prescription, with the reason; 409 once the pharmacy has dispensed it. */
export async function voidPrescription(db: Queryable, id: string, reason: string, by: string): Promise<Prescription> {
  const prescription = await getPrescription(db, id);
  if (prescription.status === 'dispensed') throw new AppError(409, 'dispensed', 'already dispensed: it can no longer be voided');
  return toPrescription(await voidRecord(db, 'prescriptions', { id, version: prescription.version, by, reason, status: 'void' }));
}

/**
 * #64: a doctor confirms an uploaded draft with its final lines. The checks run now (409 rx_alerts unless cleared);
 * then it can be dispensed. 409 unless it is an uploaded draft.
 */
export async function confirmUpload(
  db: Queryable,
  id: string,
  input: { version: number; lines: RxLine[]; acknowledgedAlerts?: string[] },
  by: string,
  now = new Date(),
): Promise<Prescription> {
  const prescription = await getPrescription(db, id);
  if (prescription.source !== 'uploaded' || prescription.status !== 'draft') {
    throw new AppError(409, 'not_draft', 'only an uploaded draft is confirmed; this one is ' + prescription.status);
  }
  const acknowledged = input.acknowledgedAlerts ?? [];
  assertAlertsCleared(await checkLines(db, prescription.patientId, input.lines), acknowledged);
  await updateRecord(db, 'prescriptions', {
    id,
    version: input.version,
    by,
    set: {
      status: 'confirmed',
      lines: JSON.stringify(input.lines),
      acknowledged_alerts: JSON.stringify(acknowledged),
      confirmed_at: now,
      confirmed_by: by,
    },
  });
  return getPrescription(db, id);
}
