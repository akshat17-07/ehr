import type { Queryable } from '../../db/migrate.js';

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
