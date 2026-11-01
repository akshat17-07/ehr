// Every record table is made with createTable(): the same base columns everywhere, and the API may
// read, add and change rows but never delete them (api-list.md "base fields"; corrections are new versions).

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

/** The two statements for a new record table: CREATE TABLE with the base columns first, then the grant (no DELETE). */
export function createTable(name: string, columns: string[]): string[] {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Bad table name: ${name}`);
  return [`CREATE TABLE ${name} (${[...BASE_COLUMNS, ...columns].join(', ')})`, grantApp(name)];
}

/** The API's rights on a table: read, add, change. Never DELETE. */
export function grantApp(name: string): string {
  return `GRANT SELECT, INSERT, UPDATE ON ${name} TO ehr_app`;
}

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
