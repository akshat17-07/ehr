// Every record table is made with createTable(): the same base columns everywhere, and the API may
// read, add and change rows but never delete them (api-list.md "base fields"; corrections are new versions).
// Each one also gets a history table, <name>_versions, that keeps the old row on every edit (db/records.ts).

/** Base columns of every record table. IDs are UUIDs made by the API (crypto.randomUUID()). */
export const BASE_COLUMNS = [
  'id uuid PRIMARY KEY',
  'version integer NOT NULL DEFAULT 1',
  'status text NOT NULL',
  'created_at timestamptz NOT NULL DEFAULT now()',
  'created_by text NOT NULL',
  'updated_at timestamptz NOT NULL DEFAULT now()',
  'updated_by text NOT NULL',
  'voided_at timestamptz',
  'voided_by text',
  'void_reason text',
];

/** Columns of every history table: the old row as JSON, and who replaced it, when and why. */
export const HISTORY_COLUMNS = [
  'record_id uuid NOT NULL',
  'version integer NOT NULL',
  'data text NOT NULL',
  'replaced_at timestamptz NOT NULL DEFAULT now()',
  'replaced_by text NOT NULL',
  'reason text',
  // One row per (record, version): two saves of the same version can't both be kept.
  'PRIMARY KEY (record_id, version)',
];

/** The history table of a record table. */
export const historyTable = (name: string) => `${name}_versions`;

/**
 * The statements for a new record table: CREATE TABLE with the base columns first and its grant (no DELETE),
 * then its history table (read + add only).
 */
export function createTable(name: string, columns: string[]): string[] {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || name.endsWith('_versions')) throw new Error(`Bad table name: ${name}`);
  const history = historyTable(name);
  return [
    `CREATE TABLE ${name} (${[...BASE_COLUMNS, ...columns].join(', ')})`,
    grantApp(name),
    `CREATE TABLE ${history} (${HISTORY_COLUMNS.join(', ')})`,
    grantReadAdd(history),
  ];
}

/**
 * A log table (no base columns, rows never change): CREATE TABLE, then a grant of read + add only.
 * Only for tables listed in APPEND_ONLY_TABLES.
 */
export function appendOnlyTable(name: string, columns: string[]): string[] {
  if (!APPEND_ONLY_TABLES.includes(name)) throw new Error(`${name} is not in APPEND_ONLY_TABLES`);
  return [`CREATE TABLE ${name} (${columns.join(', ')})`, grantReadAdd(name)];
}

/** Log tables whose rows can only be added: the API can't change or delete them. History tables are the same. */
export const APPEND_ONLY_TABLES = ['audit_events'];

export const isAppendOnly = (name: string) => APPEND_ONLY_TABLES.includes(name) || name.endsWith('_versions');

/** The API's rights on a log or history table: read and add. */
export function grantReadAdd(name: string): string {
  return `GRANT SELECT, INSERT ON ${name} TO ehr_app`;
}

/** The API's rights on a table: read, add, change. Never DELETE. */
export function grantApp(name: string): string {
  return `GRANT SELECT, INSERT, UPDATE ON ${name} TO ehr_app`;
}

/** A SQL text literal: single quotes doubled. Only for seed rows written into migrations. */
const literal = (value: string | boolean) => (typeof value === 'boolean' ? String(value) : `'${value.replaceAll("'", "''")}'`);

/**
 * An INSERT for a built-in row a migration adds (created by 'system', status active).
 * The fixed id and ON CONFLICT DO NOTHING let the migration run twice safely.
 */
export function seedInsert(table: string, id: string, values: Record<string, string | boolean>): string {
  const columns = Object.keys(values);
  if (![table, ...columns].every((n) => /^[a-z][a-z0-9_]*$/.test(n))) throw new Error(`Bad name in seed for ${table}`);
  const all = { id, status: 'active', created_by: 'system', updated_by: 'system', ...values };
  return `INSERT INTO ${table} (${Object.keys(all).join(', ')}) VALUES (${Object.values(all).map(literal).join(', ')}) ON CONFLICT (id) DO NOTHING`;
}

/** Fixed ids for seed rows: `prefix` is 8 hex digits per table, `n` counts from 1. */
export const seedId = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface BaseRow {
  id: string;
  version: number;
  status: string;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
}

/** The base fields as the API returns them (camelCase; void fields only when voided). */
export function baseFields(row: BaseRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    ...(row.voided_at && {
      voidedAt: row.voided_at.toISOString(),
      voidedBy: row.voided_by,
      voidReason: row.void_reason,
    }),
  };
}
