import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { UUID } from '../users/users.js';

// The drug list (api-list.md Drug). Every drug is also an inventory item with the same id (batches: #13).

export const DRUG_SCHEDULES = ['OTC', 'H', 'H1', 'X', 'NDPS'] as const;
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number];

export interface Drug {
  id: string;
  version: number;
  name: string;
  strength?: string;
  form?: string;
  schedule: DrugSchedule;
  hsn?: string;
  /** Percent. */
  gstRate?: number;
  mrpPaise?: number;
  /** The NPPA ceiling price per unit; null when none. */
  ceilingPaise: number | null;
  active: boolean;
}

const opt = (v: unknown) => (v == null ? undefined : String(v));
const optNumber = (v: unknown) => (v == null ? undefined : Number(v));

function toDrug(r: Record<string, unknown>): Drug {
  const drug: Drug = {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    strength: opt(r.strength),
    form: opt(r.form),
    schedule: r.schedule as DrugSchedule,
    hsn: opt(r.hsn),
    gstRate: optNumber(r.gst_rate),
    mrpPaise: optNumber(r.mrp_paise),
    ceilingPaise: optNumber(r.ceiling_paise) ?? null,
    active: r.active === true,
  };
  for (const key of Object.keys(drug) as (keyof Drug)[]) if (drug[key] === undefined) delete drug[key];
  return drug;
}

export interface DrugSearch {
  /** Part of the name, at least 2 characters. */
  q: string;
  schedule?: DrugSchedule;
  limit?: number;
}

/** #12: active drugs whose name has `q`; names that start with it come first. */
export async function searchDrugs(db: Queryable, search: DrugSearch): Promise<Drug[]> {
  const q = search.q.toLowerCase().replace(/[\\%_]/g, '\\$&');
  const params: unknown[] = [`%${q}%`, `${q}%`, search.limit ?? 20];
  const schedule = search.schedule ? (params.push(search.schedule), `AND schedule = $${params.length}`) : '';
  const { rows } = await db.query(
    `SELECT * FROM drugs WHERE active AND lower(name) LIKE $1 ${schedule}
     ORDER BY (lower(name) LIKE $2) DESC, name, strength, id LIMIT $3`,
    params,
  );
  return rows.map(toDrug);
}

/** #706: one drug (active or not); 404 if none. */
export async function getDrug(db: Queryable, id: string): Promise<Drug> {
  const row = UUID.test(id) ? (await db.query('SELECT * FROM drugs WHERE id = $1', [id])).rows[0] : undefined;
  if (!row) throw new AppError(404, 'not_found');
  return toDrug(row);
}

export type AdminDrug = Omit<Drug, 'ceilingPaise'> & { ceilingPaise?: number };

// The Admin's add and edit leave ceilingPaise out when there is none; the staff reads say null (#705).
function toAdminDrug(r: Record<string, unknown>): AdminDrug {
  const { ceilingPaise, ...rest } = toDrug(r);
  return ceilingPaise === null ? rest : { ...rest, ceilingPaise };
}

export interface NewDrug {
  name: string;
  strength?: string;
  form?: string;
  schedule: DrugSchedule;
  hsn?: string;
  gstRate?: number;
  mrpPaise?: number;
  ceilingPaise?: number;
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);

function checkCeiling(mrpPaise: number | undefined, ceilingPaise: number | undefined) {
  if (mrpPaise !== undefined && ceilingPaise !== undefined && mrpPaise > ceilingPaise) throw invalid('mrpPaise cannot be above ceilingPaise');
}

/** #193: adds a drug (active, version 1). 422 if the MRP is above the ceiling. */
export async function addDrug(db: Queryable, input: NewDrug, by: string): Promise<AdminDrug> {
  checkCeiling(input.mrpPaise, input.ceilingPaise);
  const { rows } = await db.query(
    `INSERT INTO drugs (id, status, created_by, updated_by, name, strength, form, schedule, hsn, gst_rate, mrp_paise, ceiling_paise, active)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, true) RETURNING *`,
    [randomUUID(), by, input.name, input.strength ?? null, input.form ?? null, input.schedule, input.hsn ?? null, input.gstRate ?? null, input.mrpPaise ?? null, input.ceilingPaise ?? null],
  );
  return toAdminDrug(rows[0] as Record<string, unknown>);
}

export interface DrugChange extends Partial<NewDrug> {
  version: number;
  active?: boolean;
  reason?: string;
}

const COLUMNS = {
  name: 'name', strength: 'strength', form: 'form', schedule: 'schedule', hsn: 'hsn',
  gstRate: 'gst_rate', mrpPaise: 'mrp_paise', ceilingPaise: 'ceiling_paise', active: 'active',
} as const;

/**
 * #194: edits a drug, or (de)activates it; drugs are never removed. 404 if there is none, 409 for a stale version,
 * 422 if nothing changes or the merged MRP is above the merged ceiling.
 */
export async function changeDrug(db: Queryable, id: string, change: DrugChange, by: string): Promise<AdminDrug> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM drugs WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  const current = toAdminDrug(rows[0]);
  const set: Record<string, unknown> = {};
  const merged: Record<string, unknown> = { ...current };
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = change[field as keyof typeof COLUMNS];
    if (value !== undefined && value !== (current as unknown as Record<string, unknown>)[field]) {
      set[column] = value;
      merged[field] = value;
    }
  }
  if (Object.keys(set).length === 0) throw invalid('nothing to change');
  checkCeiling(merged.mrpPaise as number | undefined, merged.ceilingPaise as number | undefined);
  return toAdminDrug(await updateRecord(db, 'drugs', { id, version: change.version, by, set, reason: change.reason }));
}
