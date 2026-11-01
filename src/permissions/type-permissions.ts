import type { Queryable } from '../db/migrate.js';
import { updateRecord } from '../db/records.js';
import { seedId, seedInsert } from '../db/table.js';
import type { Permission } from './catalog.js';
import { DEFAULT_TYPE_PERMISSIONS, STAFF_TYPES, type StaffType } from './defaults.js';

// type_permissions: one row per staff type with its current permission list (api-list.md TypePermissions).

/** The INSERTs that put the built-in lists in a new database. */
export function seedTypePermissions(): string[] {
  return STAFF_TYPES.map((type, i) =>
    seedInsert('type_permissions', seedId('7e000000', i + 1), { type, permissions: JSON.stringify(DEFAULT_TYPE_PERMISSIONS[type]) }),
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

export interface TypePermissionsChange {
  type: StaffType;
  version: number;
  permissions: Permission[];
  by: string;
  reason: string;
}

/** Saves a staff type's list if `version` is still the latest (409 otherwise). The old list goes to the history table. */
export async function saveTypePermissions(db: Queryable, change: TypePermissionsChange): Promise<TypePermissions> {
  const { rows } = await db.query('SELECT id FROM type_permissions WHERE type = $1', [change.type]);
  const id = String(rows[0]?.id);
  const row = await updateRecord(db, 'type_permissions', {
    id,
    version: change.version,
    by: change.by,
    set: { permissions: JSON.stringify(change.permissions) },
    reason: change.reason,
  });
  return fromRow(row);
}
