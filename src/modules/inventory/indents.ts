import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
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
