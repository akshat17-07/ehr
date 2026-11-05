import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import type { Address } from '../reference/hospital.js';
import { UUID } from '../users/users.js';

// Suppliers (api-list.md Supplier, #292-#294): who the store buys from. Never deleted; active=false retires one.
// address is JSON text (api-list.md Address). Names are unique (compared without case).

export interface Supplier {
  id: string;
  version: number;
  name: string;
  gstin?: string;
  drugLicenceNo?: string;
  phone?: string;
  email?: string;
  address?: Address;
  active: boolean;
}

export function toSupplier(r: Record<string, unknown>): Supplier {
  return {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    ...(r.gstin != null && { gstin: String(r.gstin) }),
    ...(r.drug_licence_no != null && { drugLicenceNo: String(r.drug_licence_no) }),
    ...(r.phone != null && { phone: String(r.phone) }),
    ...(r.email != null && { email: String(r.email) }),
    ...(r.address != null && { address: JSON.parse(String(r.address)) as Address }),
    active: r.active !== false,
  };
}

const taken = () => new AppError(409, 'duplicate', 'a supplier with this name exists');
const nameLike = (q: string) => `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;

/** #292: suppliers A to Z; q matches name, GSTIN or licence number. */
export async function listSuppliers(db: Queryable, query: { q?: string; active?: boolean }): Promise<Supplier[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.active !== undefined) where.push(`COALESCE(active, true) = $${params.push(query.active)}`);
  if (query.q) {
    const p = params.push(nameLike(query.q));
    where.push(`(lower(name) LIKE $${p} OR lower(COALESCE(gstin, '')) LIKE $${p} OR lower(COALESCE(drug_licence_no, '')) LIKE $${p})`);
  }
  const { rows } = await db.query(`SELECT * FROM suppliers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id LIMIT 1000`, params);
  return rows.map(toSupplier);
}

/** #706: one supplier; 404 if none. */
export async function getSupplier(db: Queryable, id: string): Promise<Supplier> {
  const row = UUID.test(id) ? (await db.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0] : undefined;
  if (!row) throw new AppError(404, 'not_found');
  return toSupplier(row);
}

export interface NewSupplier {
  name: string;
  gstin?: string;
  drugLicenceNo?: string;
  phone?: string;
  email?: string;
  address?: Address;
}

/** #293: adds a supplier (active, version 1). 409 duplicate if the name is taken. */
export async function addSupplier(db: Queryable, input: NewSupplier, by: string): Promise<Supplier> {
  if ((await db.query('SELECT id FROM suppliers WHERE lower(name) = $1', [input.name.toLowerCase()])).rows[0]) throw taken();
  const { rows } = await db.query(
    `INSERT INTO suppliers (id, status, created_by, updated_by, name, gstin, drug_licence_no, phone, email, address, active)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
    [
      randomUUID(),
      by,
      input.name,
      input.gstin ?? null,
      input.drugLicenceNo ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.address ? JSON.stringify(input.address) : null,
    ],
  );
  return toSupplier(rows[0] as Record<string, unknown>);
}

/** null clears an optional field. */
export interface SupplierChange {
  version: number;
  name?: string;
  gstin?: string | null;
  drugLicenceNo?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: Address | null;
  active?: boolean;
  reason?: string;
}

const COLUMNS: Record<string, string> = {
  name: 'name',
  gstin: 'gstin',
  drugLicenceNo: 'drug_licence_no',
  phone: 'phone',
  email: 'email',
  address: 'address',
  active: 'active',
};

/**
 * #294: edits a supplier. 404, 409 (stale version, or name taken), 422 (nothing changes). Returns the supplier and
 * the changes made as [before, after] per field.
 */
export async function changeSupplier(
  db: Queryable,
  id: string,
  input: SupplierChange,
  by: string,
): Promise<{ supplier: Supplier; changes: Record<string, [unknown, unknown]> }> {
  const row = UUID.test(id) ? (await db.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0] : undefined;
  if (!row) throw new AppError(404, 'not_found');
  const current = toSupplier(row);
  const set: Record<string, unknown> = {};
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = input[field as keyof SupplierChange];
    if (value === undefined) continue;
    const was = current[field as keyof Supplier] ?? null;
    if (JSON.stringify(was) === JSON.stringify(value)) continue;
    set[column] = field === 'address' && value !== null ? JSON.stringify(value) : value;
    changes[field] = [was, value];
  }
  if (Object.keys(set).length === 0) throw new AppError(422, 'invalid_input', 'nothing to change');
  if (input.name !== undefined && changes.name) {
    const same = await db.query('SELECT id FROM suppliers WHERE lower(name) = $1 AND id <> $2', [input.name.toLowerCase(), id]);
    if (same.rows[0]) throw taken();
  }
  const saved = await updateRecord(db, 'suppliers', { id, version: input.version, by, set, ...(input.reason && { reason: input.reason }) });
  return { supplier: toSupplier(saved), changes };
}
