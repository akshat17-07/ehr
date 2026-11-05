import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { assertPatientAccess, type Caller } from '../access/patient-access.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';
import { prepareIssue, writeIssue, type StockIssue } from './issues.js';
import { ITEMS } from './items.js';

// Indents (api-list.md Indent): a ward asks the store for items, for the ward or for one patient. The store issues
// against it at #278.

export interface Indent extends Omit<BaseFields, 'status'> {
  status: 'requested' | 'issued' | 'cancelled';
  ward: string;
  patientId?: string;
  lines: { itemId: string; qty: number }[];
}

export function toIndent(r: Record<string, unknown>): Indent {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Indent['status'],
    ward: String(r.ward),
    ...(r.patient_id != null && { patientId: String(r.patient_id) }),
    lines: JSON.parse(String(r.lines)) as Indent['lines'],
  };
}

/** #109: 422 for an unknown or inactive item, or the same item twice; 404 for an unknown patient. */
export async function requestIndent(db: Queryable, input: Omit<Indent, keyof BaseFields | 'status'>, by: string): Promise<Indent> {
  if (input.patientId) await getPatient(db, input.patientId);
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, 'validation_failed', 'lines: an item is listed twice');
  const { rows } = await db.query(`${ITEMS} WHERE i.active AND i.id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  const active = new Set(rows.map((r) => String(r.id)));
  const missing = ids.findIndex((id) => !active.has(id));
  if (missing >= 0) throw new AppError(422, 'validation_failed', `lines[${missing}].itemId: no such active item`);
  const { rows: inserted } = await db.query(
    `INSERT INTO indents (id, status, created_by, updated_by, ward, patient_id, lines) VALUES ($1, 'requested', $2, $2, $3, $4, $5) RETURNING *`,
    [randomUUID(), by, input.ward, input.patientId ?? null, JSON.stringify(input.lines)],
  );
  return toIndent(inserted[0] as Record<string, unknown>);
}

/** The patient ids among these that the caller may not open (sensitive label, inactive rule). */
async function blockedPatients(db: Queryable, caller: Caller, ids: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (const id of ids) {
    try {
      await assertPatientAccess(db, caller, await getPatient(db, id));
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 403 && e.status !== 404)) throw e;
      blocked.add(id);
    }
  }
  return blocked;
}

/**
 * #710: indents newest first. A patient filter needs patient access (403 otherwise); without it, indents of
 * patients the caller may not open are left out of the page.
 */
export async function listIndents(
  db: Queryable,
  caller: Caller,
  query: PageQuery & { status?: Indent['status']; patientId?: string },
): Promise<Page<Indent>> {
  if (query.patientId) await assertPatientAccess(db, caller, await getPatient(db, query.patientId));
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  const page = await pageRows(db, { select: 'SELECT * FROM indents', where, params, orderBy: ['created_at', 'id'], direction: 'desc' }, query, toIndent);
  const patients = query.patientId ? [] : [...new Set(page.items.flatMap((i) => (i.patientId ? [i.patientId] : [])))];
  const blocked = await blockedPatients(db, caller, patients);
  return { ...page, items: page.items.filter((i) => !i.patientId || !blocked.has(i.patientId)) };
}

/** #710: one indent with its lines; 404 if none; 403 when it is for a patient the caller may not open. */
export async function getIndent(db: Queryable, caller: Caller, id: string): Promise<Indent> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM indents WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  const indent = toIndent(rows[0]);
  if (indent.patientId) await assertPatientAccess(db, caller, await getPatient(db, indent.patientId));
  return indent;
}

/**
 * #278: the store issues against a requested indent; the items are charged to the patient and the indent is issued.
 * 404 for no indent; 409 not_requested once issued or cancelled; 422 for another patient than the indent's, an item
 * not on the indent, or more of an item than asked.
 */
export async function issueIndent(
  db: Queryable,
  id: string,
  input: { patientId: string; lines: { itemId: string; batchId: string; qty: number }[] },
  by: string,
  now = new Date(),
): Promise<{ indent: Indent; issue: StockIssue }> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM indents WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  const indent = toIndent(rows[0]);
  if (indent.status !== 'requested') throw new AppError(409, 'not_requested', 'this indent is ' + indent.status);
  if (indent.patientId && indent.patientId !== input.patientId) throw new AppError(422, 'validation_failed', "patientId: not the indent's patient");
  const asked = new Map(indent.lines.map((l) => [l.itemId, l.qty]));
  const giving = new Map<string, number>();
  input.lines.forEach((l, i) => {
    if (!asked.has(l.itemId)) throw new AppError(422, 'validation_failed', `lines[${i}].itemId: not on the indent`);
    giving.set(l.itemId, (giving.get(l.itemId) ?? 0) + l.qty);
  });
  for (const [itemId, qty] of giving) {
    if (qty > asked.get(itemId)!) throw new AppError(422, 'validation_failed', `lines: ${qty} of an item asked for ${asked.get(itemId)}`);
  }
  const prepared = await prepareIssue(db, { patientId: input.patientId, indentId: indent.id, lines: input.lines }, now);
  return withTransaction(db, async (tx) => {
    const issue = await writeIssue(tx, prepared, by);
    const row = await updateRecord(tx, 'indents', { id: indent.id, version: indent.version, by, set: { status: 'issued' } });
    return { indent: toIndent(row), issue };
  });
}
