import type { Queryable } from '../db/migrate.js';
import { seedId, seedInsert } from '../db/table.js';
import type { Permission } from './catalog.js';

// Bundles: named sets of permissions given to a user on top of their type (api-list.md Bundle; section 4 "B").
// The built-in ones are made with the database; an Admin can add more and edit them (settings.bundles).

export const BUILT_IN_BUNDLES = {
  reception: [
    'patient.register', 'patient.update', 'appointment.view', 'appointment.create', 'appointment.update',
    'referrer.view', 'referrer.create_pseudo', 'referral.record',
  ],
  // result.record is not in the table; lab staff enter results, so it goes with the other health data.
  health_data: ['vitals.record', 'observation.record', 'result.record'],
  records: ['document.view', 'document.upload', 'document.misfile', 'records.release', 'fhir.export'],
  billing: [
    'bill.view', 'bill.create', 'bill.update', 'bill.finalise', 'bill.void', 'bill.discount',
    'payment.mark_paid', 'deposit.create', 'deposit.apply', 'refund.create', 'report.finance',
  ],
  store: ['stock.view', 'stock.receive', 'inventory.add', 'stock.indent', 'stock.quarantine', 'stock.count', 'stock.issue', 'stock.supplier_return'],
  tpa: ['insurance.policy', 'insurance.agent_link', 'claim.view', 'claim.create', 'claim.update'],
} as const satisfies Record<string, readonly Permission[]>;

export interface Bundle {
  id: string;
  version: number;
  name: string;
  permissions: Permission[];
  builtIn: boolean;
}

/** The INSERTs that put the built-in bundles in a new database. */
export function seedBundles(): string[] {
  return Object.entries(BUILT_IN_BUNDLES).map(([name, permissions], i) =>
    seedInsert('bundles', seedId('b0000000', i + 1), { name, permissions: JSON.stringify(permissions), built_in: true }),
  );
}

function fromRow(row: Record<string, unknown>): Bundle {
  return {
    id: String(row.id),
    version: Number(row.version),
    name: String(row.name),
    permissions: JSON.parse(String(row.permissions)) as Permission[],
    builtIn: row.built_in === true,
  };
}

/** Every active bundle, by name. */
export async function listBundles(db: Queryable): Promise<Bundle[]> {
  const { rows } = await db.query("SELECT id, version, name, permissions, built_in FROM bundles WHERE status = 'active' ORDER BY name");
  return rows.map(fromRow);
}

/** The named bundles that exist and are active (unknown names are left out). */
export async function bundlesNamed(db: Queryable, names: readonly string[]): Promise<Bundle[]> {
  if (names.length === 0) return [];
  // IN ($1, $2 ...) rather than = ANY($1): DSQL has no array types.
  const list = names.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT id, version, name, permissions, built_in FROM bundles WHERE status = 'active' AND name IN (${list}) ORDER BY name`,
    [...names],
  );
  return rows.map(fromRow);
}
