// Database changes, in order. Never edit or remove one that has run; add a new one instead.
// Aurora DSQL rules: one DDL statement per transaction (each string below runs on its own),
// no foreign keys or triggers, and indexes are created with `CREATE INDEX ASYNC`.
// Make record tables with createTable() (db/table.ts): base columns + `GRANT SELECT, INSERT, UPDATE` (never DELETE).
// Log tables use appendOnlyTable() instead (read + add only). test/table.test.ts checks every migration follows these rules.
import { seedBundles } from '../permissions/bundles.js';
import { seedTypePermissions } from '../permissions/type-permissions.js';
import { appendOnlyTable, createTable } from './table.js';

export interface MigrationContext {
  /** IAM role of the API Lambda; it logs in as ehr_app. */
  apiRoleArn: string;
  /** `dsql` in AWS (default); `postgres` for the local database (npm run dev, tests). */
  dialect?: 'dsql' | 'postgres';
}

export interface Migration {
  id: string;
  statements: (ctx: MigrationContext) => string[];
}

/**
 * The same statement for plain Postgres, or null to skip it there.
 * Only the two DSQL-only forms differ: IAM grants (no IAM locally) and async indexes.
 */
export function toPostgres(sql: string): string | null {
  if (/^\s*AWS IAM GRANT\b/i.test(sql)) return null;
  return sql.replace(/\bCREATE (UNIQUE )?INDEX ASYNC\b/i, (_m, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX`);
}

export const migrations: Migration[] = [
  {
    id: '0001_app_role',
    statements: ({ apiRoleArn }) => [
      'CREATE ROLE ehr_app WITH LOGIN',
      `AWS IAM GRANT ehr_app TO '${apiRoleArn}'`,
    ],
  },
  {
    // Hash-chained audit log (src/audit/log.ts). changes is JSON text: DSQL has no json columns.
    id: '0002_audit_events',
    statements: () => [
      ...appendOnlyTable('audit_events', [
        'seq bigint PRIMARY KEY',
        'id uuid NOT NULL',
        'at timestamptz NOT NULL',
        'user_id text NOT NULL',
        'role text NOT NULL',
        'action text NOT NULL',
        'patient_id uuid',
        'record_type text',
        'record_id text',
        'changes text',
        'reason text',
        'ip text NOT NULL',
        'device text NOT NULL',
        'prev_hash text NOT NULL',
        'hash text NOT NULL',
      ]),
      // "Who viewed this patient" and "what did this user do".
      'CREATE INDEX ASYNC audit_events_patient ON audit_events (patient_id, at)',
      'CREATE INDEX ASYNC audit_events_user ON audit_events (user_id, at)',
    ],
  },
  {
    // Each staff type's permissions (api-list.md section 4), filled with the built-in lists. permissions is a JSON array.
    id: '0003_type_permissions',
    statements: () => [
      ...createTable('type_permissions', ['type text NOT NULL', 'permissions text NOT NULL']),
      'CREATE UNIQUE INDEX ASYNC type_permissions_type ON type_permissions (type)',
      ...seedTypePermissions(),
    ],
  },
  {
    // Permission bundles (api-list.md Bundle), with the built-in ones. permissions is a JSON array.
    id: '0004_bundles',
    statements: () => [
      ...createTable('bundles', ['name text NOT NULL', 'permissions text NOT NULL', 'built_in boolean NOT NULL DEFAULT false']),
      'CREATE UNIQUE INDEX ASYNC bundles_name ON bundles (name)',
      ...seedBundles(),
    ],
  },
  {
    // Each staff member's custom allow / deny lists (#307). user_id is the Cognito sub; the lists are JSON arrays.
    id: '0005_user_permissions',
    statements: () => [
      ...createTable('user_permissions', ['user_id text NOT NULL', 'allow text NOT NULL', 'deny text NOT NULL']),
      'CREATE UNIQUE INDEX ASYNC user_permissions_user ON user_permissions (user_id)',
    ],
  },
  {
    // Time-limited grants (api-list.md Grant). status: active or revoked; "expired" is worked out from ends_at.
    id: '0006_grants',
    statements: () => [
      ...createTable('grants', [
        'user_id text NOT NULL',
        'permission text NOT NULL',
        'scope text NOT NULL',
        'scope_id text',
        'starts_at timestamptz NOT NULL',
        'ends_at timestamptz NOT NULL',
        'grantor_id text NOT NULL',
        'reason text NOT NULL',
      ]),
      // "This user's grants now" on every permission check.
      'CREATE INDEX ASYNC grants_user ON grants (user_id, ends_at)',
    ],
  },
  {
    // A user's bundles (#157) sit with their custom lists, so one row read gives everything beyond their type.
    // NULL = no bundles (DSQL adds columns without defaults).
    id: '0007_user_bundles',
    statements: () => ['ALTER TABLE user_permissions ADD COLUMN bundles text'],
  },
  {
    // Hospital departments (api-list.md Department).
    id: '0008_departments',
    statements: () => [
      ...createTable('departments', ['code text NOT NULL', 'name_en text NOT NULL', 'name_hi text NOT NULL', 'active boolean NOT NULL DEFAULT true']),
      'CREATE UNIQUE INDEX ASYNC departments_code ON departments (code)',
    ],
  },
  {
    // The drug list (api-list.md Drug). schedule: OTC, H, H1, X or NDPS. Money in paise; gst_rate in percent.
    id: '0009_drugs',
    statements: () => [
      ...createTable('drugs', [
        'name text NOT NULL',
        'strength text',
        'form text',
        'schedule text NOT NULL',
        'hsn text',
        'gst_rate integer',
        'mrp_paise bigint',
        'active boolean NOT NULL DEFAULT true',
      ]),
      // Search by name as the user types (GET /staff/drugs).
      'CREATE INDEX ASYNC drugs_name ON drugs (name)',
    ],
  },
  {
    // Staff and partner accounts (api-list.md User); sign-in is in Cognito, linked by cognito_sub.
    // department_ids is a JSON array. Bundles are kept in user_permissions (0007).
    id: '0010_users',
    statements: () => [
      ...createTable('users', [
        'cognito_sub text NOT NULL',
        'name text NOT NULL',
        'email text NOT NULL',
        'mobile text NOT NULL',
        'type text NOT NULL',
        'department_ids text NOT NULL',
        'council_name text',
        'council_reg_no text',
        'reg_valid_till date',
        'pharmacist_reg_no text',
        'active boolean NOT NULL DEFAULT true',
      ]),
      'CREATE UNIQUE INDEX ASYNC users_cognito_sub ON users (cognito_sub)',
      'CREATE UNIQUE INDEX ASYNC users_email ON users (email)',
    ],
  },
  {
    // In-app alerts for one staff member (api-list.md Alert). read_at is set when they open it (#4).
    id: '0011_alerts',
    statements: () => [
      ...createTable('alerts', [
        'user_id text NOT NULL',
        'kind text NOT NULL',
        'title text NOT NULL',
        'body text NOT NULL',
        'link text',
        'read_at timestamptz',
      ]),
      'CREATE INDEX ASYNC alerts_user ON alerts (user_id, created_at)',
    ],
  },
  {
    // Requests to open an inactive patient's record (api-list.md AccessRequest). status: pending, approved, rejected.
    id: '0012_access_requests',
    statements: () => [
      ...createTable('access_requests', [
        'patient_id text NOT NULL',
        'requested_by text NOT NULL',
        'reason text NOT NULL',
        'approver_id text',
        'decided_at timestamptz',
        'decision_reason text',
        'valid_until timestamptz',
      ]),
      'CREATE INDEX ASYNC access_requests_requested_by ON access_requests (requested_by, created_at)',
      // The approvals inbox (#174) lists by status.
      'CREATE INDEX ASYNC access_requests_status ON access_requests (status, created_at)',
    ],
  },
  {
    // Employees on the payroll (api-list.md Employee). user_id links a login; contract staff may have none.
    // *_enc columns hold ciphertext: PAN, UAN, ESIC and bank details are encrypted by the app before saving.
    id: '0013_employees',
    statements: () => [
      ...createTable('employees', [
        'user_id text',
        'name text NOT NULL',
        'designation text NOT NULL',
        'join_date date NOT NULL',
        'pan_enc text NOT NULL',
        'uan_enc text',
        'esic_enc text',
        'bank_enc text NOT NULL',
        'salary_structure_id text NOT NULL',
        'active boolean NOT NULL DEFAULT true',
      ]),
      'CREATE UNIQUE INDEX ASYNC employees_user ON employees (user_id)',
    ],
  },
  {
    // One payroll run per month (api-list.md PayrollRun). status: draft, approved, paid.
    id: '0014_payroll_runs',
    statements: () => [
      ...createTable('payroll_runs', ['month text NOT NULL', 'total_net_paise bigint NOT NULL', 'run_by text NOT NULL', 'approved_by text']),
      'CREATE UNIQUE INDEX ASYNC payroll_runs_month ON payroll_runs (month)',
    ],
  },
  {
    // One payslip per employee per run (api-list.md Payslip). deductions is a JSON array; pdf_key is the S3 object.
    id: '0015_payslips',
    statements: () => [
      ...createTable('payslips', [
        'run_id uuid NOT NULL',
        'employee_id uuid NOT NULL',
        'month text NOT NULL',
        'gross_paise bigint NOT NULL',
        'deductions text NOT NULL',
        'net_paise bigint NOT NULL',
        'pdf_key text',
      ]),
      'CREATE UNIQUE INDEX ASYNC payslips_run_employee ON payslips (run_id, employee_id)',
      'CREATE INDEX ASYNC payslips_employee ON payslips (employee_id, month)',
    ],
  },
];
