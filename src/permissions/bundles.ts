import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/migrate.js';
import { updateRecord } from '../db/records.js';
import { AppError } from '../middleware/errors.js';
import { seedId, seedInsert } from '../db/table.js';
import { isPermission, PERMISSIONS, type Permission } from './catalog.js';
import { GRANT_ONLY } from './defaults.js';

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

const ADMIN_ONLY = new Set<string>(PERMISSIONS.filter((p) => p.adminOnly).map((p) => p.key));

/** 422 for an unknown, Admin-only or grant-only permission (those are never bundled). Sorted, without repeats. */
export function checkBundlePermissions(keys: readonly string[]): Permission[] {
  const issues = keys.flatMap((key) =>
    !isPermission(key)
      ? [`unknown permission: ${key}`]
      : ADMIN_ONLY.has(key)
        ? [`${key} is Admin-only`]
        : GRANT_ONLY.includes(key)
          ? [`${key} is given only with a grant`]
          : [],
  );
  if (issues.length) throw new AppError(422, 'invalid_input', issues.join('; '));
  return [...new Set(keys)].sort() as Permission[];
}

/** #165: 409 duplicate if the name is taken (bundle names are never reused). */
export async function addBundle(db: Queryable, input: { name: string; permissions: string[] }, by: string): Promise<Bundle> {
  const permissions = checkBundlePermissions(input.permissions);
  const { rows: taken } = await db.query('SELECT id FROM bundles WHERE name = $1', [input.name]);
  if (taken[0]) throw new AppError(409, 'duplicate', 'a bundle with this name exists', { bundleId: String(taken[0].id) });
  const { rows } = await db.query(
    `INSERT INTO bundles (id, status, created_by, updated_by, name, permissions, built_in) VALUES ($1, 'active', $2, $2, $3, $4, false)
     RETURNING id, version, name, permissions, built_in`,
    [randomUUID(), by, input.name, JSON.stringify(permissions)],
  );
  return fromRow(rows[0] as Record<string, unknown>);
}

/**
 * #166: 404 for no bundle; 409 built_in for a built-in one; 409 duplicate for a taken name; 409 in_use to rename a
 * bundle users hold (users keep bundles by name). New permissions reach every holder at once.
 */
export async function changeBundle(
  db: Queryable,
  id: string,
  change: { version: number; name?: string; permissions?: string[]; reason?: string },
  by: string,
): Promise<Bundle> {
  const { rows } = await db.query("SELECT id, version, name, permissions, built_in FROM bundles WHERE id::text = $1 AND status = 'active'", [id]);
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such bundle');
  const bundle = fromRow(rows[0] as Record<string, unknown>);
  if (bundle.builtIn) throw new AppError(409, 'built_in', 'built-in bundles cannot be changed');
  const set: Record<string, unknown> = {};
  if (change.permissions) set.permissions = JSON.stringify(checkBundlePermissions(change.permissions));
  if (change.name !== undefined && change.name !== bundle.name) {
    const { rows: taken } = await db.query('SELECT id FROM bundles WHERE name = $1', [change.name]);
    if (taken[0]) throw new AppError(409, 'duplicate', 'a bundle with this name exists', { bundleId: String(taken[0].id) });
    const { rows: holders } = await db.query('SELECT user_id FROM user_permissions WHERE bundles LIKE $1', [`%${JSON.stringify(bundle.name)}%`]);
    if (holders.length > 0) throw new AppError(409, 'in_use', 'users hold this bundle; take it off them before renaming', { users: holders.length });
    set.name = change.name;
  }
  if (Object.keys(set).length === 0) throw new AppError(422, 'invalid_input', 'nothing to change');
  return fromRow(await updateRecord(db, 'bundles', { id: bundle.id, version: change.version, by, set, ...(change.reason && { reason: change.reason }) }));
}
