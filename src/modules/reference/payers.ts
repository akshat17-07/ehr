import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';

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

/** #307 (api-list #195): adds a partner hospital. 409 duplicate if the name is taken (names are unique). */
export async function addPartnerHospital(db: Queryable, name: string, by: string): Promise<PartnerHospital> {
  const taken = () => new AppError(409, 'duplicate', 'a partner hospital with this name exists');
  if ((await db.query('SELECT id FROM partner_hospitals WHERE name = $1', [name])).rows[0]) throw taken();
  try {
    const { rows } = await db.query(
      `INSERT INTO partner_hospitals (id, status, created_by, updated_by, name) VALUES ($1, 'active', $2, $2, $3) RETURNING *`,
      [randomUUID(), by, name],
    );
    return base(rows[0] as Record<string, unknown>);
  } catch (error) {
    // 23505: another request took the name between the check and the insert.
    if ((error as { code?: string }).code === '23505') throw taken();
    throw error;
  }
}
