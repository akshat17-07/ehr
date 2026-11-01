import type { Queryable } from '../../db/migrate.js';

// Short name lists (api-list.md PartnerHospital, Insurer, Tpa), read whole, A to Z. Inactive insurers and TPAs are
// still listed, so old records can show their names; pickers offer the active ones.

export interface PartnerHospital {
  id: string;
  version: number;
  name: string;
}

/** An insurer or a TPA (third-party administrator). */
export interface Payer {
  id: string;
  version: number;
  name: string;
  code?: string;
  active: boolean;
}

const base = (r: Record<string, unknown>) => ({ id: String(r.id), version: Number(r.version), name: String(r.name) });

const toPayer = (r: Record<string, unknown>): Payer => ({
  ...base(r),
  ...(r.code != null && { code: String(r.code) }),
  active: r.active === true,
});

/** #14 */
export async function listPartnerHospitals(db: Queryable): Promise<PartnerHospital[]> {
  return (await db.query('SELECT * FROM partner_hospitals ORDER BY name, id')).rows.map(base);
}

/** #15 */
export async function listInsurers(db: Queryable): Promise<Payer[]> {
  return (await db.query('SELECT * FROM insurers ORDER BY name, id')).rows.map(toPayer);
}

/** #16 */
export async function listTpas(db: Queryable): Promise<Payer[]> {
  return (await db.query('SELECT * FROM tpas ORDER BY name, id')).rows.map(toPayer);
}
