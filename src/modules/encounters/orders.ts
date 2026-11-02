import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Orders (api-list.md Order): a lab test, imaging or procedure asked for in an encounter. `code` is the hospital's
// or the lab's own test code (free text: there is no one list). Status: ordered, resulted on the first result (#60),
// or cancelled with a reason (#61).

export const ORDER_KINDS = ['lab', 'imaging', 'procedure'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_STATUSES = ['ordered', 'resulted', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface Order extends Omit<BaseFields, 'status'> {
  status: OrderStatus;
  encounterId: string;
  patientId: string;
  kind: OrderKind;
  code?: string;
  name: string;
  notes?: string;
  // Filled in when results are built (#176).
  results: unknown[];
}

export function toOrder(r: Record<string, unknown>): Order {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as OrderStatus,
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    kind: r.kind as OrderKind,
    ...(r.code != null && { code: String(r.code) }),
    name: String(r.name),
    ...(r.notes != null && { notes: String(r.notes) }),
    results: [],
  };
}

export interface NewOrder {
  kind: OrderKind;
  code?: string;
  name: string;
  notes?: string;
}

/** #58: only in an open encounter. */
export async function addOrder(db: Queryable, encounterId: string, input: NewOrder, by: string): Promise<Order> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const { rows } = await db.query(
    `INSERT INTO orders (id, status, created_by, updated_by, encounter_id, patient_id, kind, code, name, notes)
     VALUES ($1, 'ordered', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, input.kind, input.code ?? null, input.name, input.notes ?? null],
  );
  return toOrder(rows[0] as Record<string, unknown>);
}
