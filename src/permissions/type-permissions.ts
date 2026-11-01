import type { Queryable } from '../db/migrate.js';
import type { Permission } from './catalog.js';
import { DEFAULT_TYPE_PERMISSIONS, STAFF_TYPES, type StaffType } from './defaults.js';

// type_permissions: one row per staff type with its current permission list (api-list.md TypePermissions).

/** Fixed ids for the rows the first migration adds, so the seed can safely run twice. */
export const TYPE_ROW_IDS: Record<StaffType, string> = Object.fromEntries(
  STAFF_TYPES.map((type, i) => [type, `7e000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]),
) as Record<StaffType, string>;

/** The INSERTs that put the built-in lists in a new database. */
export function seedTypePermissions(): string[] {
  return STAFF_TYPES.map(
    (type) =>
      `INSERT INTO type_permissions (id, status, created_by, updated_by, type, permissions) VALUES ('${TYPE_ROW_IDS[type]}', 'active', 'system', 'system', '${type}', '${JSON.stringify(DEFAULT_TYPE_PERMISSIONS[type])}') ON CONFLICT (id) DO NOTHING`,
  );
}

export interface TypePermissions {
  type: StaffType;
  version: number;
  permissions: Permission[];
  /** The built-in list, used by "reset". */
  defaults: Permission[];
}

function fromRow(row: Record<string, unknown>): TypePermissions {
  const type = row.type as StaffType;
  return {
    type,
    version: Number(row.version),
    permissions: JSON.parse(String(row.permissions)) as Permission[],
    defaults: DEFAULT_TYPE_PERMISSIONS[type],
  };
}

/** Every staff type's permissions, in STAFF_TYPES order (GET /admin/type-permissions, #308). */
export async function listTypePermissions(db: Queryable): Promise<TypePermissions[]> {
  const { rows } = await db.query('SELECT type, version, permissions FROM type_permissions');
  const byType = new Map(rows.map((r) => [String(r.type), fromRow(r)]));
  return STAFF_TYPES.flatMap((type) => byType.get(type) ?? []);
}

/** The permissions the given staff types have between them (a user is normally in one type). */
export async function permissionsOfTypes(db: Queryable, types: readonly string[]): Promise<Set<Permission>> {
  if (types.length === 0) return new Set();
  // IN ($1, $2 ...) rather than = ANY($1): DSQL has no array types.
  const list = types.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(`SELECT permissions FROM type_permissions WHERE type IN (${list})`, [...types]);
  return new Set(rows.flatMap((r) => JSON.parse(String(r.permissions)) as Permission[]));
}
