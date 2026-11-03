// Database changes, in order. Never edit or remove one that has run; add a new one instead.
// Aurora DSQL rules: one DDL statement per transaction (each string below runs on its own),
// no foreign keys or triggers, and indexes are created with `CREATE INDEX ASYNC`.
// Make record tables with createTable() (db/table.ts): base columns + `GRANT SELECT, INSERT, UPDATE` (never DELETE).
// Log tables use appendOnlyTable() instead (read + add only). test/table.test.ts checks every migration follows these rules.
import { seedBundles } from '../permissions/bundles.js';
import { seedTypePermissions } from '../permissions/type-permissions.js';
import { seedVitalSigns } from '../modules/reference/codes.js';
import { seedHospital } from '../modules/reference/hospital.js';
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
    // *_enc columns hold ciphertext: Aadhaar, PAN, UAN, ESIC and bank details are encrypted by the app before saving.
    // aadhaar_hash is a keyed hash of the Aadhaar number, so it can be unique (ciphertext is random).
    // Edited in place on 2026-11-03, before any deploy: Aadhaar added; pan_enc and bank_enc made optional.
    id: '0013_employees',
    statements: () => [
      ...createTable('employees', [
        'user_id text',
        'name text NOT NULL',
        'designation text NOT NULL',
        'join_date date NOT NULL',
        'aadhaar_enc text',
        'aadhaar_hash text',
        'pan_enc text',
        'uan_enc text',
        'esic_enc text',
        'bank_enc text',
        'salary_structure_id text NOT NULL',
        'active boolean NOT NULL DEFAULT true',
      ]),
      'CREATE UNIQUE INDEX ASYNC employees_user ON employees (user_id)',
      'CREATE UNIQUE INDEX ASYNC employees_aadhaar ON employees (aadhaar_hash)',
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
  {
    // The hospital's own details (api-list.md Hospital): one row, blank until the Admin fills it in (#189).
    id: '0016_hospital',
    statements: () => [
      ...createTable('hospital', [
        'name text NOT NULL',
        'address text NOT NULL',
        'phone text NOT NULL',
        'email text NOT NULL',
        'mp_licence_no text NOT NULL',
        'licence_valid_till date',
        'gstin text',
        'pcpndt_reg_no text',
        'mtp_reg_no text',
        'invoice_prefix text NOT NULL',
        'bill_of_supply_prefix text NOT NULL',
      ]),
      seedHospital(),
    ],
  },
  {
    // The price list (api-list.md Tariff). Money in paise; gst_rate in percent; setting: opd, ipd or both.
    // list_version counts the price lists made with POST /admin/tariffs (#192); valid_to is set when a newer list starts.
    id: '0017_tariffs',
    statements: () => [
      ...createTable('tariffs', [
        'list_version integer NOT NULL',
        'code text NOT NULL',
        'name_en text NOT NULL',
        'name_hi text',
        'department_id uuid',
        'price_paise bigint NOT NULL',
        'gst_rate integer NOT NULL',
        'sac_code text',
        'setting text NOT NULL',
        'valid_from date NOT NULL',
        'valid_to date',
      ]),
      // One price per code per list; the lists in force on a date are found by valid_from.
      'CREATE UNIQUE INDEX ASYNC tariffs_list_code ON tariffs (list_version, code)',
      'CREATE INDEX ASYNC tariffs_valid_from ON tariffs (valid_from)',
    ],
  },
  {
    // Stock batches (api-list.md Batch). item_id is the drug's or item's id. Money in paise.
    // The quantities change only with stock movements; quarantined stock is still on hand.
    id: '0018_batches',
    statements: () => [
      ...createTable('batches', [
        'item_id uuid NOT NULL',
        'batch_no text NOT NULL',
        'expiry date NOT NULL',
        'supplier_id uuid',
        'cost_paise bigint NOT NULL',
        'mrp_paise bigint NOT NULL',
        'qty_on_hand integer NOT NULL DEFAULT 0',
        'qty_quarantined integer NOT NULL DEFAULT 0',
        'recalled boolean NOT NULL DEFAULT false',
      ]),
      'CREATE UNIQUE INDEX ASYNC batches_item_batch_no ON batches (item_id, batch_no)',
      // FEFO: an item's batches by expiry.
      'CREATE INDEX ASYNC batches_item_expiry ON batches (item_id, expiry)',
    ],
  },
  {
    // Hospitals patients are referred to or from (api-list.md PartnerHospital): only the name is kept.
    id: '0019_partner_hospitals',
    statements: () => [
      ...createTable('partner_hospitals', ['name text NOT NULL']),
      'CREATE UNIQUE INDEX ASYNC partner_hospitals_name ON partner_hospitals (name)',
    ],
  },
  {
    // Insurance companies (api-list.md Insurer).
    id: '0020_insurers',
    statements: () => [
      ...createTable('insurers', ['name text NOT NULL', 'code text', 'active boolean NOT NULL DEFAULT true']),
      'CREATE UNIQUE INDEX ASYNC insurers_name ON insurers (name)',
    ],
  },
  {
    // Third-party administrators who settle cashless claims for insurers (api-list.md Tpa).
    id: '0021_tpas',
    statements: () => [
      ...createTable('tpas', ['name text NOT NULL', 'code text', 'active boolean NOT NULL DEFAULT true']),
      'CREATE UNIQUE INDEX ASYNC tpas_name ON tpas (name)',
    ],
  },
  {
    // Code lists (api-list.md Code): system is icd10 or loinc. The LOINC vital signs are built in.
    id: '0022_codes',
    statements: () => [
      ...createTable('codes', ['system text NOT NULL', 'code text NOT NULL', 'text text NOT NULL']),
      'CREATE UNIQUE INDEX ASYNC codes_system_code ON codes (system, code)',
      ...seedVitalSigns(),
    ],
  },
  {
    // Patients (api-list.md Patient). name_search is the name in lower case, for searching by its start.
    // age_years is the age given at registration (no date of birth), on age_recorded_on. address, labels and
    // allergies are JSON. merged_into is set when the patient is merged into another (#181).
    id: '0023_patients',
    statements: () => [
      ...createTable('patients', [
        'uhid text NOT NULL',
        'name text NOT NULL',
        'name_search text NOT NULL',
        'sex text NOT NULL',
        'dob date',
        'age_years integer',
        'age_recorded_on date',
        'mobile text',
        'email text',
        'address text',
        'unknown boolean NOT NULL DEFAULT false',
        'emergency_note text',
        'labels text NOT NULL',
        'last_activity_at timestamptz',
        'allergies text NOT NULL',
        'active_policy_id uuid',
        'referrer_id uuid',
        'merged_into uuid',
      ]),
      'CREATE UNIQUE INDEX ASYNC patients_uhid ON patients (uhid)',
      'CREATE INDEX ASYNC patients_mobile ON patients (mobile)',
      'CREATE INDEX ASYNC patients_name_search ON patients (name_search, id)',
    ],
  },
  {
    // Running numbers (db/counters.ts): DSQL has no sequences. A count is not kept in counters_versions.
    id: '0024_counters',
    statements: () => [
      ...createTable('counters', ['name text NOT NULL', 'value bigint NOT NULL']),
      'CREATE UNIQUE INDEX ASYNC counters_name ON counters (name)',
    ],
  },
  {
    // A patient's guardians (api-list.md Guardian); guardian_patient_id when the guardian is a patient too.
    id: '0025_guardians',
    statements: () => [
      ...createTable('guardians', [
        'patient_id uuid NOT NULL',
        'guardian_patient_id uuid',
        'name text NOT NULL',
        'relation text NOT NULL',
        'mobile text',
        'portal_access boolean NOT NULL DEFAULT false',
      ]),
      'CREATE INDEX ASYNC guardians_patient ON guardians (patient_id)',
    ],
  },
  {
    // Who brought in an unknown emergency patient (#21). DSQL can add a column with no default.
    id: '0026_patients_brought_by',
    statements: () => ['ALTER TABLE patients ADD COLUMN brought_by text'],
  },
  {
    // A patient's consents (api-list.md Consent): never changed except withdrawn_at (#256).
    id: '0027_consents',
    statements: () => [
      ...createTable('consents', [
        'patient_id uuid NOT NULL',
        'kind text NOT NULL',
        'notice_version text',
        'language text NOT NULL',
        'given boolean NOT NULL',
        'given_at timestamptz NOT NULL',
        'withdrawn_at timestamptz',
        'document_id uuid',
      ]),
      'CREATE INDEX ASYNC consents_patient ON consents (patient_id)',
    ],
  },
  {
    // Proposed merges of duplicate patients (api-list.md PatientMerge); status pending / approved / rejected.
    id: '0028_patient_merges',
    statements: () => [
      ...createTable('patient_merges', [
        'keep_patient_id uuid NOT NULL',
        'merge_patient_id uuid NOT NULL',
        'reason text NOT NULL',
        'proposed_by text NOT NULL',
        'approved_by text',
      ]),
      'CREATE INDEX ASYNC patient_merges_status ON patient_merges (status)',
    ],
  },
  {
    // Break-glass (api-list.md BreakGlassEvent); review_outcome is justified / not_justified (#184).
    id: '0029_break_glass_events',
    statements: () => [
      ...createTable('break_glass_events', [
        'patient_id uuid NOT NULL',
        'user_id text NOT NULL',
        'reason text NOT NULL',
        'at timestamptz NOT NULL',
        'valid_until timestamptz NOT NULL',
        'reviewed_by text',
        'review_outcome text',
        'review_note text',
      ]),
      'CREATE INDEX ASYNC break_glass_events_user ON break_glass_events (user_id, patient_id)',
      'CREATE INDEX ASYNC break_glass_events_at ON break_glass_events (at)',
    ],
  },
  {
    // OPD appointments (api-list.md Appointment). doctor_id is the doctor's users.id. ends_at = at + duration, for
    // finding a clash with a taken slot.
    id: '0030_appointments',
    statements: () => [
      ...createTable('appointments', [
        'patient_id uuid NOT NULL',
        'doctor_id uuid NOT NULL',
        'department_id uuid NOT NULL',
        'at timestamptz NOT NULL',
        'ends_at timestamptz NOT NULL',
        'duration_min integer NOT NULL',
        'note text',
      ]),
      'CREATE INDEX ASYNC appointments_at ON appointments (at)',
      'CREATE INDEX ASYNC appointments_doctor ON appointments (doctor_id, at)',
    ],
  },
  {
    // Encounters (api-list.md Encounter); status open / closed. One per appointment at most.
    id: '0031_encounters',
    statements: () => [
      ...createTable('encounters', [
        'patient_id uuid NOT NULL',
        'type text NOT NULL',
        'department_id uuid NOT NULL',
        'doctor_id uuid NOT NULL',
        'appointment_id uuid',
        'started_at timestamptz NOT NULL',
        'closed_at timestamptz',
      ]),
      'CREATE INDEX ASYNC encounters_patient ON encounters (patient_id, started_at)',
      'CREATE INDEX ASYNC encounters_started ON encounters (started_at)',
      'CREATE UNIQUE INDEX ASYNC encounters_appointment ON encounters (appointment_id)',
    ],
  },
  {
    // Vitals (api-list.md Vital): one set of readings per row, any of them missing.
    id: '0032_vitals',
    statements: () => [
      ...createTable('vitals', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'taken_at timestamptz NOT NULL',
        'bp_sys integer',
        'bp_dia integer',
        'pulse integer',
        'temp_c numeric(4,1)',
        'spo2 integer',
        'resp_rate integer',
        'weight_kg numeric(6,2)',
        'height_cm numeric(5,1)',
        'blood_sugar_mg_dl integer',
      ]),
      'CREATE INDEX ASYNC vitals_encounter ON vitals (encounter_id, taken_at)',
      'CREATE INDEX ASYNC vitals_patient ON vitals (patient_id, taken_at)',
    ],
  },
  {
    // Observations (api-list.md Observation): a LOINC-coded value, a number (value_num) or text (value_text).
    id: '0033_observations',
    statements: () => [
      ...createTable('observations', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'loinc text NOT NULL',
        'name text NOT NULL',
        'value_num numeric',
        'value_text text',
        'unit text',
        'taken_at timestamptz NOT NULL',
      ]),
      'CREATE INDEX ASYNC observations_encounter ON observations (encounter_id, taken_at)',
      'CREATE INDEX ASYNC observations_patient ON observations (patient_id, loinc, taken_at)',
    ],
  },
  {
    // Clinical notes (api-list.md Note); status draft / signed. addenda is a JSON list of { text, by, at }.
    id: '0034_notes',
    statements: () => [
      ...createTable('notes', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'kind text NOT NULL',
        'text text NOT NULL',
        'signed_at timestamptz',
        'signed_by text',
        'addenda text NOT NULL',
      ]),
      'CREATE INDEX ASYNC notes_encounter ON notes (encounter_id, created_at)',
      'CREATE INDEX ASYNC notes_patient ON notes (patient_id, created_at)',
    ],
  },
  {
    // The ward shift a nursing note was written in (#49): morning, evening or night.
    id: '0035_notes_shift',
    statements: () => ['ALTER TABLE notes ADD COLUMN shift text'],
  },
  {
    // Diagnoses (api-list.md Diagnosis): ICD-10 coded, provisional or final.
    id: '0036_diagnoses',
    statements: () => [
      ...createTable('diagnoses', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'icd10 text NOT NULL',
        'text text NOT NULL',
        'kind text NOT NULL',
      ]),
      'CREATE INDEX ASYNC diagnoses_encounter ON diagnoses (encounter_id, created_at)',
      'CREATE INDEX ASYNC diagnoses_patient ON diagnoses (patient_id, created_at)',
    ],
  },
  {
    // Allergies (api-list.md Allergy). patients.allergies stays the list of active substances, for the banner.
    id: '0037_allergies',
    statements: () => [
      ...createTable('allergies', [
        'patient_id uuid NOT NULL',
        'substance text NOT NULL',
        'drug_id uuid',
        'reaction text',
        'severity text NOT NULL',
      ]),
      'CREATE INDEX ASYNC allergies_patient ON allergies (patient_id, created_at)',
    ],
  },
  {
    // Problem list (api-list.md Problem): long-standing conditions; status active / resolved.
    id: '0038_problems',
    statements: () => [
      ...createTable('problems', ['patient_id uuid NOT NULL', 'icd10 text', 'text text NOT NULL', 'onset date', 'resolved_at date']),
      'CREATE INDEX ASYNC problems_patient ON problems (patient_id, created_at)',
    ],
  },
  {
    // Lab, imaging and procedure orders (api-list.md Order); status ordered / resulted / cancelled.
    id: '0039_orders',
    statements: () => [
      ...createTable('orders', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'kind text NOT NULL',
        'code text',
        'name text NOT NULL',
        'notes text',
      ]),
      'CREATE INDEX ASYNC orders_encounter ON orders (encounter_id)',
      'CREATE INDEX ASYNC orders_patient ON orders (patient_id, created_at)',
      'CREATE INDEX ASYNC orders_status ON orders (status, created_at)',
    ],
  },
  {
    // Results of an order (api-list.md Result): a number with its unit, text, or (later) a scanned report.
    id: '0040_order_results',
    statements: () => [
      ...createTable('order_results', [
        'order_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'value_num numeric',
        'unit text',
        'text text',
        'document_id uuid',
        'resulted_at timestamptz NOT NULL',
      ]),
      'CREATE INDEX ASYNC order_results_order ON order_results (order_id, resulted_at)',
    ],
  },
  {
    // Prescriptions (api-list.md Prescription): typed, or an uploaded photo/PDF whose lines the doctor confirms.
    // lines and acknowledged_alerts are JSON text. status: draft / confirmed / dispensed / void.
    id: '0041_prescriptions',
    statements: () => [
      ...createTable('prescriptions', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'doctor_id uuid NOT NULL',
        'source text NOT NULL',
        'document_id uuid',
        'lines text NOT NULL',
        'acknowledged_alerts text',
        'confirmed_at timestamptz',
        'confirmed_by text',
      ]),
      'CREATE INDEX ASYNC prescriptions_encounter ON prescriptions (encounter_id)',
      'CREATE INDEX ASYNC prescriptions_patient ON prescriptions (patient_id, created_at)',
    ],
  },
  {
    // IPD admissions (api-list.md Admission). While current, bed_key (ward|bed) and current_patient are set, and their
    // unique indexes keep one patient per bed and one current admission per patient; discharge clears both.
    id: '0042_admissions',
    statements: () => [
      ...createTable('admissions', [
        'patient_id uuid NOT NULL',
        'encounter_id uuid NOT NULL',
        'department_id uuid NOT NULL',
        'doctor_id uuid NOT NULL',
        'ward text NOT NULL',
        'bed text NOT NULL',
        'reason text',
        'admitted_at timestamptz NOT NULL',
        'discharged_at timestamptz',
        'bed_key text',
        'current_patient uuid',
      ]),
      'CREATE UNIQUE INDEX ASYNC admissions_bed_key ON admissions (bed_key)',
      'CREATE UNIQUE INDEX ASYNC admissions_current_patient ON admissions (current_patient)',
      'CREATE INDEX ASYNC admissions_patient ON admissions (patient_id, admitted_at)',
      'CREATE INDEX ASYNC admissions_encounter ON admissions (encounter_id)',
    ],
  },
  {
    // Medication administration record (api-list.md MarEntry): each dose given, held or refused on the ward.
    id: '0043_mar_entries',
    statements: () => [
      ...createTable('mar_entries', [
        'admission_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'prescription_id uuid NOT NULL',
        'line_index integer NOT NULL',
        'at timestamptz NOT NULL',
        'outcome text NOT NULL',
        'dose text',
        'note text',
      ]),
      'CREATE INDEX ASYNC mar_entries_admission ON mar_entries (admission_id, at)',
    ],
  },
  {
    // Discharge summaries (api-list.md DischargeSummary): one per IPD encounter; medicines is JSON text of RxLines.
    id: '0044_discharge_summaries',
    statements: () => [
      ...createTable('discharge_summaries', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'diagnosis_text text NOT NULL',
        'course text NOT NULL',
        'procedures text',
        'medicines text NOT NULL',
        'advice text NOT NULL',
        'follow_up_date date',
        'signed_at timestamptz',
        'signed_by text',
      ]),
      'CREATE UNIQUE INDEX ASYNC discharge_summaries_encounter ON discharge_summaries (encounter_id)',
    ],
  },
  {
    // Dental chart (api-list.md DentalEntry): findings and treatment per tooth, FDI numbering.
    id: '0045_dental_entries',
    statements: () => [
      ...createTable('dental_entries', [
        'patient_id uuid NOT NULL',
        'encounter_id uuid',
        'tooth text NOT NULL',
        'surface text',
        'condition text NOT NULL',
        'treatment text',
        'at timestamptz NOT NULL',
      ]),
      'CREATE INDEX ASYNC dental_entries_patient ON dental_entries (patient_id, at)',
    ],
  },
  {
    // Antenatal care visits (api-list.md AncRecord).
    id: '0046_anc_records',
    statements: () => [
      ...createTable('anc_records', [
        'patient_id uuid NOT NULL',
        'encounter_id uuid',
        'lmp date',
        'edd date',
        'gravida integer',
        'para integer',
        'gestation_weeks integer',
        'bp text',
        'weight_kg numeric(5,1)',
        'fundal_height_cm numeric(4,1)',
        'fhr integer',
        'notes text',
      ]),
      'CREATE INDEX ASYNC anc_records_patient ON anc_records (patient_id, created_at)',
    ],
  },
  {
    // PC-PNDT Form F (api-list.md FormF), one per encounter. There is no fetal-sex column, by law.
    id: '0047_form_f',
    statements: () => [
      ...createTable('form_f', [
        'encounter_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'doctor_id uuid NOT NULL',
        'indication text NOT NULL',
        'procedure text NOT NULL',
        'declaration_signed boolean NOT NULL',
        'document_id uuid',
      ]),
      'CREATE UNIQUE INDEX ASYNC form_f_encounter ON form_f (encounter_id)',
      // The monthly PCPNDT register (#217).
      'CREATE INDEX ASYNC form_f_created ON form_f (created_at)',
    ],
  },
  {
    // MTP register (api-list.md MtpEntry). opinion_doctor_ids is a JSON list of user ids.
    id: '0048_mtp_register',
    statements: () => [
      ...createTable('mtp_register', [
        'patient_id uuid NOT NULL',
        'admission_date date NOT NULL',
        'gestation_weeks integer NOT NULL',
        'indication text NOT NULL',
        'opinion_doctor_ids text NOT NULL',
        'procedure_date date',
        'document_id uuid',
      ]),
      'CREATE INDEX ASYNC mtp_register_admission ON mtp_register (admission_date, id)',
    ],
  },
  {
    // Surgeries (api-list.md Surgery), here or at a partner hospital. status: scheduled / done / cancelled.
    // team_ids and consent_document_ids are JSON lists; checklist and op_note are JSON objects.
    id: '0049_surgeries',
    statements: () => [
      ...createTable('surgeries', [
        'patient_id uuid NOT NULL',
        'procedure text NOT NULL',
        'site text',
        'side text',
        'surgeon_id uuid NOT NULL',
        'team_ids text NOT NULL',
        'scheduled_at timestamptz NOT NULL',
        'venue text NOT NULL',
        'partner_hospital_id uuid',
        'charges_paise bigint NOT NULL',
        'consent_document_ids text NOT NULL',
        'instructions text',
        'checklist text',
        'op_note text',
      ]),
      'CREATE INDEX ASYNC surgeries_scheduled ON surgeries (scheduled_at, id)',
      'CREATE INDEX ASYNC surgeries_patient ON surgeries (patient_id, scheduled_at)',
    ],
  },
  {
    // Implants put in at a surgery (api-list.md Implant): batch and MRP, as the sticker shows, for recalls and the bill.
    id: '0050_implants',
    statements: () => [
      ...createTable('implants', [
        'surgery_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'name text NOT NULL',
        'manufacturer text',
        'batch_no text NOT NULL',
        'size text',
        'sticker_document_id uuid',
        'mrp_paise bigint NOT NULL',
      ]),
      'CREATE INDEX ASYNC implants_surgery ON implants (surgery_id)',
      // A recall: which patients got this batch.
      'CREATE INDEX ASYNC implants_batch ON implants (batch_no)',
    ],
  },
  {
    // What we paid a partner hospital for a surgery there (api-list.md VenuePayment): an expense, never shown to patients.
    id: '0051_venue_payments',
    statements: () => [
      ...createTable('venue_payments', [
        'surgery_id uuid NOT NULL',
        'partner_hospital_id uuid NOT NULL',
        'amount_paise bigint NOT NULL',
        'paid_on date NOT NULL',
        'mode text NOT NULL',
        'reference text',
      ]),
      'CREATE INDEX ASYNC venue_payments_surgery ON venue_payments (surgery_id)',
      // The ledger and the surgery-margin report read by date.
      'CREATE INDEX ASYNC venue_payments_paid_on ON venue_payments (paid_on, id)',
    ],
  },
  {
    // Patient files (api-list.md Document): the file is in the files bucket at s3_key; sha256 is hex.
    // status: pending (link given, not uploaded yet) / ready / misfiled. linked_from: the misfiled original (#99).
    id: '0052_documents',
    statements: () => [
      ...createTable('documents', [
        'patient_id uuid NOT NULL',
        'type text NOT NULL',
        'file_name text NOT NULL',
        'mime text NOT NULL',
        'size_bytes bigint NOT NULL',
        'sha256 text NOT NULL',
        's3_key text NOT NULL',
        'uploaded_at timestamptz',
        'linked_from uuid',
      ]),
      'CREATE INDEX ASYNC documents_patient ON documents (patient_id, created_at)',
      // "Is this file already on the patient's record?" (#94).
      'CREATE INDEX ASYNC documents_patient_hash ON documents (patient_id, sha256)',
    ],
  },
  {
    // The pharmacy queue (#100): confirmed prescriptions by the time they were confirmed.
    id: '0053_prescriptions_queue',
    statements: () => ['CREATE INDEX ASYNC prescriptions_status_confirmed ON prescriptions (status, confirmed_at)'],
  },
  {
    // Medicines handed over against a prescription (api-list.md Dispense). lines is JSON: lineIndex, drugId, batchId,
    // qty, and the H1/X and NDPS register details. pharmacist_id is the users row (with a pharmacist reg. no.).
    id: '0054_dispenses',
    statements: () => [
      ...createTable('dispenses', [
        'prescription_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'pharmacist_id uuid NOT NULL',
        'lines text NOT NULL',
        'dispensed_at timestamptz NOT NULL',
      ]),
      'CREATE INDEX ASYNC dispenses_prescription ON dispenses (prescription_id)',
      // The H1, X and NDPS registers (#113-115) read dispenses by time.
      'CREATE INDEX ASYNC dispenses_at ON dispenses (dispensed_at)',
    ],
  },
  {
    // Medicines a patient brought back (#103): lines is JSON (dispense line index, qty, batchId, refund). The ledger
    // (#347) reads the refunds from here.
    id: '0055_pharmacy_returns',
    statements: () => [
      ...createTable('pharmacy_returns', [
        'dispense_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'lines text NOT NULL',
        'reason text NOT NULL',
        'refund_paise bigint NOT NULL',
        'refund_mode text NOT NULL',
      ]),
      'CREATE INDEX ASYNC pharmacy_returns_dispense ON pharmacy_returns (dispense_id)',
      'CREATE INDEX ASYNC pharmacy_returns_created ON pharmacy_returns (created_at)',
    ],
  },
  {
    // Pharmacy bills (api-list.md PharmacyBill). lines is JSON. MRP includes GST: gst_paise is the GST inside the
    // total. number: the OPD tax invoice number (none for IPD, which goes on the ward bill).
    id: '0056_pharmacy_bills',
    statements: () => [
      ...createTable('pharmacy_bills', [
        'patient_id uuid NOT NULL',
        'dispense_id uuid',
        'setting text NOT NULL',
        'number text',
        'lines text NOT NULL',
        'total_paise bigint NOT NULL',
        'gst_paise bigint NOT NULL',
        'paid_paise bigint NOT NULL DEFAULT 0',
      ]),
      'CREATE INDEX ASYNC pharmacy_bills_created ON pharmacy_bills (created_at)',
      'CREATE INDEX ASYNC pharmacy_bills_patient ON pharmacy_bills (patient_id, created_at)',
      'CREATE INDEX ASYNC pharmacy_bills_dispense ON pharmacy_bills (dispense_id)',
    ],
  },
  {
    // Inventory items other than drugs (api-list.md Item): consumables, surgical items, implants, lab reagents.
    // Drugs stay in drugs and show up as items of kind drug with the same id; batches.item_id points at either.
    id: '0057_items',
    statements: () => [
      ...createTable('items', [
        'name text NOT NULL',
        'kind text NOT NULL',
        'unit text NOT NULL',
        'pack_size integer',
        'hsn text',
        'gst_rate integer',
        'mrp_paise bigint',
        'active boolean NOT NULL DEFAULT true',
      ]),
      'CREATE INDEX ASYNC items_name ON items (name)',
    ],
  },
  {
    // Suppliers (api-list.md Supplier); address is JSON. Managed at #292-294.
    id: '0058_suppliers',
    statements: () => [
      ...createTable('suppliers', [
        'name text NOT NULL',
        'gstin text',
        'drug_licence_no text',
        'phone text',
        'email text',
        'address text',
        'active boolean NOT NULL DEFAULT true',
      ]),
    ],
  },
  {
    // The NPPA ceiling price (DPCO) of a scheduled formulation, per unit; a GRN can't bring in a batch above it.
    id: '0059_drugs_ceiling',
    statements: () => ['ALTER TABLE drugs ADD COLUMN ceiling_paise bigint'],
  },
  {
    // Goods received (api-list.md Grn): one supplier invoice; lines is JSON with the batch each line went into.
    id: '0060_grns',
    statements: () => [
      ...createTable('grns', [
        'supplier_id uuid NOT NULL',
        'purchase_order_id uuid',
        'invoice_no text NOT NULL',
        'invoice_date date NOT NULL',
        'lines text NOT NULL',
        'received_by text NOT NULL',
      ]),
      // One entry per supplier invoice.
      'CREATE UNIQUE INDEX ASYNC grns_supplier_invoice ON grns (supplier_id, invoice_no)',
      'CREATE INDEX ASYNC grns_created ON grns (created_at)',
    ],
  },
  {
    // A ward asking the store for items (api-list.md Indent); lines is JSON. status: requested / issued / cancelled.
    id: '0061_indents',
    statements: () => [
      ...createTable('indents', ['ward text NOT NULL', 'patient_id uuid', 'lines text NOT NULL']),
      'CREATE INDEX ASYNC indents_status ON indents (status, created_at)',
    ],
  },
  {
    // Stock set aside (api-list.md Quarantine): it stays on hand but can't be used. recall_id: set by a recall (#112).
    id: '0062_quarantines',
    statements: () => [
      ...createTable('quarantines', ['batch_id uuid NOT NULL', 'item_id uuid NOT NULL', 'qty integer NOT NULL', 'reason text NOT NULL', 'note text', 'recall_id uuid']),
      'CREATE INDEX ASYNC quarantines_batch ON quarantines (batch_id)',
    ],
  },
  {
    // A maker's or regulator's recall (api-list.md Recall): batch_nos and batches (what was quarantined) are JSON.
    id: '0063_recalls',
    statements: () => [
      ...createTable('recalls', ['item_id uuid NOT NULL', 'batch_nos text NOT NULL', 'reference text NOT NULL', 'note text', 'batches text NOT NULL']),
    ],
  },
  {
    // The pharmacy bill a return was refunded against (#103): refunds are at the rate the patient paid.
    id: '0064_pharmacy_returns_bill',
    statements: () => ['ALTER TABLE pharmacy_returns ADD COLUMN bill_id uuid'],
  },
  {
    // Items used on a patient (api-list.md StockIssue), priced at batch MRP; lines is JSON. bill_id: set when the
    // patient's bill takes them in (#116).
    id: '0065_stock_issues',
    statements: () => [
      ...createTable('stock_issues', [
        'patient_id uuid NOT NULL',
        'encounter_id uuid',
        'admission_id uuid',
        'surgery_id uuid',
        'indent_id uuid',
        'lines text NOT NULL',
        'total_paise bigint NOT NULL',
        'bill_id uuid',
      ]),
      'CREATE INDEX ASYNC stock_issues_patient ON stock_issues (patient_id, created_at)',
      'CREATE INDEX ASYNC stock_issues_created ON stock_issues (created_at)',
    ],
  },
  {
    // A physical count (api-list.md StockCount): what the books said and what was found; lines is JSON. Stock is
    // not changed; the differences are for Admin/Head Doctor (#304).
    id: '0066_stock_counts',
    statements: () => [
      ...createTable('stock_counts', ['lines text NOT NULL', 'note text']),
      'CREATE INDEX ASYNC stock_counts_created ON stock_counts (created_at)',
    ],
  },
  {
    // Stock sent back to a supplier (api-list.md SupplierReturn); lines is JSON (with the cost of each line).
    id: '0067_supplier_returns',
    statements: () => [
      ...createTable('supplier_returns', [
        'supplier_id uuid NOT NULL',
        'lines text NOT NULL',
        'reason text NOT NULL',
        'credit_note_no text',
        'refund_paise bigint NOT NULL',
        'refund_mode text',
      ]),
      'CREATE INDEX ASYNC supplier_returns_created ON supplier_returns (created_at)',
    ],
  },
  {
    // Stock movements (#282) read these by time.
    id: '0068_movement_indexes',
    statements: () => [
      'CREATE INDEX ASYNC pharmacy_returns_created ON pharmacy_returns (created_at)',
      'CREATE INDEX ASYNC quarantines_created ON quarantines (created_at)',
    ],
  },
  {
    // Orders to suppliers (api-list.md PurchaseOrder); made and placed at #295-#301. lines and received_qty are
    // JSON. status: draft / placed / part_received / received / cancelled.
    id: '0069_purchase_orders',
    statements: () => [
      ...createTable('purchase_orders', [
        'number text',
        'supplier_id uuid NOT NULL',
        'reorder_check_id uuid',
        'lines text NOT NULL',
        'note text',
        'placed_at timestamptz',
        "received_qty text NOT NULL DEFAULT '{}'",
      ]),
      'CREATE INDEX ASYNC purchase_orders_status ON purchase_orders (status, created_at)',
      'CREATE INDEX ASYNC purchase_orders_supplier ON purchase_orders (supplier_id)',
    ],
  },
  {
    // Patient bills (api-list.md Bill); lines is JSON. Money in paise. series: tax_invoice / bill_of_supply.
    // status: draft / final / paid / part_paid / void.
    id: '0070_bills',
    statements: () => [
      ...createTable('bills', [
        'patient_id uuid NOT NULL',
        'encounter_id uuid',
        'admission_id uuid',
        'series text NOT NULL',
        'number text',
        'lines text NOT NULL',
        'subtotal_paise bigint NOT NULL',
        'gst_paise bigint NOT NULL',
        'discount_paise bigint NOT NULL DEFAULT 0',
        'total_paise bigint NOT NULL',
        'paid_paise bigint NOT NULL DEFAULT 0',
        'finalised_at timestamptz',
      ]),
      'CREATE INDEX ASYNC bills_patient ON bills (patient_id, created_at)',
      'CREATE INDEX ASYNC bills_created ON bills (created_at)',
      'CREATE INDEX ASYNC bills_number ON bills (number)',
    ],
  },
  {
    // An IPD pharmacy bill (#104) is charged on the patient's bill: this is that bill.
    id: '0071_pharmacy_bills_bill',
    statements: () => ['ALTER TABLE pharmacy_bills ADD COLUMN bill_id uuid'],
  },
  {
    // Discounts on a bill (api-list.md Discount). status: applied / pending (over the limit, waits for #179) / rejected.
    id: '0072_discounts',
    statements: () => [
      ...createTable('discounts', ['bill_id uuid NOT NULL', 'amount_paise bigint NOT NULL', 'reason text NOT NULL', 'approved_by text']),
      'CREATE INDEX ASYNC discounts_bill ON discounts (bill_id)',
      'CREATE INDEX ASYNC discounts_status ON discounts (status, created_at)',
    ],
  },
  {
    // Discounts and refunds above these need a second person (#177, #179). Set at #189; empty means the default.
    id: '0073_hospital_limits',
    statements: () => ['ALTER TABLE hospital ADD COLUMN discount_limit_paise bigint', 'ALTER TABLE hospital ADD COLUMN refund_limit_paise bigint'],
  },
  {
    // Money received against a bill (api-list.md Payment). mode: cash / upi / card / deposit.
    id: '0074_payments',
    statements: () => [
      ...createTable('payments', ['bill_id uuid NOT NULL', 'patient_id uuid NOT NULL', 'amount_paise bigint NOT NULL', 'mode text NOT NULL', 'reference text', 'deposit_id uuid']),
      'CREATE INDEX ASYNC payments_bill ON payments (bill_id)',
      'CREATE INDEX ASYNC payments_patient ON payments (patient_id, created_at)',
      'CREATE INDEX ASYNC payments_created ON payments (created_at)',
    ],
  },
  {
    // A final bill that is voided gets a credit note (its own gap-free series); the bill's number stays used.
    id: '0075_bills_credit_note',
    statements: () => ['ALTER TABLE bills ADD COLUMN credit_note_no text'],
  },
  {
    // Advance deposits (api-list.md Deposit). receipt_no is gap-free per financial year; balance_paise goes down
    // as the deposit is used on bills (#128) or refunded.
    id: '0076_deposits',
    statements: () => [
      ...createTable('deposits', [
        'patient_id uuid NOT NULL',
        'receipt_no text NOT NULL',
        'amount_paise bigint NOT NULL',
        'balance_paise bigint NOT NULL',
        'mode text NOT NULL',
        'reference text',
      ]),
      'CREATE INDEX ASYNC deposits_patient ON deposits (patient_id, created_at)',
      'CREATE INDEX ASYNC deposits_created ON deposits (created_at)',
    ],
  },
  {
    // Refunds (api-list.md Refund) of money taken on a bill. status: approved (money off the bill's paid),
    // pending (over the hospital limit, waiting for #177) or rejected.
    id: '0077_refunds',
    statements: () => [
      ...createTable('refunds', [
        'bill_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'amount_paise bigint NOT NULL',
        'mode text NOT NULL',
        'reason text NOT NULL',
        'reference text',
        'approved_by text',
      ]),
      'CREATE INDEX ASYNC refunds_bill ON refunds (bill_id)',
      'CREATE INDEX ASYNC refunds_status ON refunds (status, created_at)',
      'CREATE INDEX ASYNC refunds_created ON refunds (created_at)',
    ],
  },
  {
    // Insurance policies on file (api-list.md Policy). document_ids is a JSON list of the patient's documents.
    id: '0078_policies',
    statements: () => [
      ...createTable('policies', [
        'patient_id uuid NOT NULL',
        'insurer_id uuid NOT NULL',
        'tpa_id uuid',
        'policy_no text NOT NULL',
        'member_id text',
        'holder_name text NOT NULL',
        'valid_from date NOT NULL',
        'valid_to date NOT NULL',
        'sum_insured_paise bigint',
        "document_ids text NOT NULL DEFAULT '[]'",
      ]),
      'CREATE INDEX ASYNC policies_patient ON policies (patient_id, created_at)',
      'CREATE INDEX ASYNC policies_number ON policies (insurer_id, policy_no)',
    ],
  },
  {
    // Insurance claims (api-list.md Claim), typed in by hand: there is no insurer or TPA portal link.
    // insurer_id is copied from the policy for the claims list filter. submitted_at starts the IRDAI timer.
    id: '0079_claims',
    statements: () => [
      ...createTable('claims', [
        'patient_id uuid NOT NULL',
        'policy_id uuid NOT NULL',
        'insurer_id uuid NOT NULL',
        'admission_id uuid',
        'kind text NOT NULL',
        'amount_claimed_paise bigint NOT NULL',
        'amount_approved_paise bigint',
        "document_ids text NOT NULL DEFAULT '[]'",
        'submitted_at timestamptz',
      ]),
      'CREATE INDEX ASYNC claims_patient ON claims (patient_id, created_at)',
      'CREATE INDEX ASYNC claims_status ON claims (status, created_at)',
      'CREATE INDEX ASYNC claims_created ON claims (created_at)',
      // Each status change of a claim (api-list.md ClaimEvent); to_status is the claim's new status.
      ...createTable('claim_events', ['claim_id uuid NOT NULL', 'to_status text NOT NULL', 'note text', 'amount_paise bigint']),
      'CREATE INDEX ASYNC claim_events_claim ON claim_events (claim_id, created_at)',
    ],
  },
  {
    // Which insurance agent may see which patient's insurance section (api-list.md AgentLink), from_date to to_date
    // (none: until ended). status: active or ended.
    id: '0080_agent_links',
    statements: () => [
      ...createTable('agent_links', ['patient_id uuid NOT NULL', 'agent_user_id uuid NOT NULL', 'from_date date NOT NULL', 'to_date date']),
      'CREATE INDEX ASYNC agent_links_agent ON agent_links (agent_user_id, patient_id)',
      'CREATE INDEX ASYNC agent_links_patient ON agent_links (patient_id, created_at)',
    ],
  },
  {
    // Doctors and clinics who send patients (api-list.md Referrer). pseudo: typed in by staff, not yet claimed by a
    // GP login (user_id). merged_into: a duplicate folded into another record (#... merge, Head Doctor / Admin).
    // name_search is the lower-case name for the search box. There are no fee or commission columns.
    id: '0081_referrers',
    statements: () => [
      ...createTable('referrers', [
        'name text NOT NULL',
        'name_search text NOT NULL',
        'clinic text',
        'town text',
        'phone text',
        'reg_no text',
        'user_id uuid',
        'merged_into uuid',
        'pseudo boolean NOT NULL',
      ]),
      'CREATE INDEX ASYNC referrers_phone ON referrers (phone)',
      'CREATE INDEX ASYNC referrers_reg_no ON referrers (reg_no)',
    ],
  },
  {
    // A patient sent by a referrer (api-list.md Referral). status: received, seen, admitted, surgery, discharged.
    // There are no fee or commission columns.
    id: '0082_referrals',
    statements: () => [
      ...createTable('referrals', ['patient_id uuid NOT NULL', 'referrer_id uuid NOT NULL', 'referral_date date NOT NULL', 'reason text']),
      'CREATE INDEX ASYNC referrals_referrer ON referrals (referrer_id, referral_date)',
      'CREATE INDEX ASYNC referrals_patient ON referrals (patient_id, created_at)',
      'CREATE INDEX ASYNC referrals_date ON referrals (referral_date)',
    ],
  },
  {
    // A patient's ask for a copy of their record (api-list.md RecordRequest), due within 72 hours. requested_by:
    // patient (portal) or counter (records desk). encounter_ids is a JSON list (scope encounter). status: pending,
    // fulfilled or rejected.
    id: '0083_record_requests',
    statements: () => [
      ...createTable('record_requests', [
        'patient_id uuid NOT NULL',
        'requested_by text NOT NULL',
        'scope text NOT NULL',
        "encounter_ids text NOT NULL DEFAULT '[]'",
        'include_sensitive boolean NOT NULL',
        'email text NOT NULL',
        'share_link_expires_at timestamptz',
      ]),
      'CREATE INDEX ASYNC record_requests_status ON record_requests (status, created_at)',
      'CREATE INDEX ASYNC record_requests_patient ON record_requests (patient_id, created_at)',
    ],
  },
  {
    // A record copy shared by link (api-list.md 9.3). Only the SHA-256 of the token is kept. The copy itself is in
    // the exports bucket (s3_key). otp_*: the one-time code for #274 / #275 (hash, expiry, sends this hour as a JSON
    // list of times, wrong tries).
    id: '0084_share_links',
    statements: () => [
      ...createTable('share_links', [
        'record_request_id uuid NOT NULL',
        'patient_id uuid NOT NULL',
        'token_hash text NOT NULL',
        's3_key text NOT NULL',
        'email text NOT NULL',
        'expires_at timestamptz NOT NULL',
        'otp_hash text',
        'otp_expires_at timestamptz',
        "otp_sends text NOT NULL DEFAULT '[]'",
        'otp_wrong_tries integer NOT NULL DEFAULT 0',
      ]),
      'CREATE UNIQUE INDEX ASYNC share_links_token ON share_links (token_hash)',
      'CREATE INDEX ASYNC share_links_request ON share_links (record_request_id)',
    ],
  },
  {
    // FHIR exports (api-list.md Export). kind: patient (#150) or full (#199). The file is in the exports bucket
    // (s3_key), which deletes it after 7 days. status: running, done or failed.
    id: '0085_exports',
    statements: () => [
      ...createTable('exports', ['kind text NOT NULL', 'patient_id uuid', 's3_key text NOT NULL', 'finished_at timestamptz']),
      'CREATE INDEX ASYNC exports_created ON exports (created_at)',
    ],
  },
  {
    // What a Head Doctor may grant (api-list.md GrantRule). status: active or ended (never removed).
    // grantor_id is users.id; may_grant is a JSON list of permission keys.
    id: '0086_grant_rules',
    statements: () => [
      ...createTable('grant_rules', [
        'grantor_id uuid NOT NULL',
        'may_grant text NOT NULL',
        'scope text NOT NULL',
        'department_id uuid',
        'max_days integer NOT NULL',
      ]),
      'CREATE INDEX ASYNC grant_rules_grantor ON grant_rules (grantor_id)',
    ],
  },
  {
    // When a refund was approved. Day close (#130) counts a refund on the day money went out: a pending one that is
    // approved later counts on its approval day. Empty for refunds approved at once (then created_at is the day).
    id: '0087_refunds_approved_at',
    statements: () => ['ALTER TABLE refunds ADD COLUMN approved_at timestamptz'],
  },
  {
    // Which rows an approved patient merge moved to the kept UHID, by table (JSON text), so it can be audited and undone.
    id: '0088_patient_merges_moved_rows',
    statements: () => ['ALTER TABLE patient_merges ADD COLUMN moved_rows text'],
  },
  {
    // The inactive-patient rule per role or user (api-list.md InactiveSetting). status: active or ended (never removed).
    // user_id is users.id. No row for a person or their role means the default: request after 10 days, Head Doctor, 24 h.
    id: '0089_inactive_settings',
    statements: () => [
      ...createTable('inactive_settings', [
        'applies_to text NOT NULL',
        'role text',
        'user_id uuid',
        'mode text NOT NULL',
        'days integer NOT NULL',
        'approver text NOT NULL',
        'access_hours integer NOT NULL',
      ]),
    ],
  },
  {
    // Partner hospitals can be switched off (api-list.md PartnerHospital active). Empty (null) counts as active, so
    // the rows made before this stay active.
    id: '0090_partner_hospitals_active',
    statements: () => ['ALTER TABLE partner_hospitals ADD COLUMN active boolean'],
  },
  {
    // Security incidents (api-list.md Incident, #222-#224). status: open, reported or closed. The CERT-In report is due
    // 6 h and the Board report 72 h after detected_at. incident_events is the timeline: rows are only added, never changed.
    id: '0091_incidents',
    statements: () => [
      ...createTable('incidents', [
        'title text NOT NULL',
        'detected_at timestamptz NOT NULL',
        'kind text NOT NULL',
        'description text NOT NULL',
        'cert_in_due_by timestamptz NOT NULL',
        'board_due_by timestamptz NOT NULL',
      ]),
      'CREATE INDEX ASYNC incidents_detected ON incidents (detected_at)',
      ...createTable('incident_events', ['incident_id uuid NOT NULL', 'at timestamptz NOT NULL', 'text text NOT NULL', '"by" text NOT NULL']),
      'CREATE INDEX ASYNC incident_events_incident ON incident_events (incident_id, at)',
    ],
  },
  {
    // Salary structures (api-list.md SalaryStructure, #320). Money is whole paise (bigint). allowances is a JSON array
    // of { name, paise } in a text column. Names are unique (plain name: kept simple, no expression index).
    id: '0092_salary_structures',
    statements: () => [
      ...createTable('salary_structures', [
        'name text NOT NULL',
        'basic_paise bigint NOT NULL',
        'hra_paise bigint NOT NULL',
        'allowances text NOT NULL',
        'epf boolean NOT NULL',
        'esi boolean NOT NULL',
        'professional_tax boolean NOT NULL',
        'tds_monthly_paise bigint',
      ]),
      'CREATE UNIQUE INDEX ASYNC salary_structures_name ON salary_structures (name)',
    ],
  },
  {
    // Salary advances (api-list.md Advance, #323). Money is whole paise. Payroll runs (#324) recover
    // min(recover_per_month_paise, balance) each month and add it to recovered_paise.
    id: '0093_advances',
    statements: () => [
      ...createTable('advances', [
        'employee_id uuid NOT NULL',
        'amount_paise bigint NOT NULL',
        'given_on date NOT NULL',
        'recover_per_month_paise bigint NOT NULL',
        'recovered_paise bigint NOT NULL DEFAULT 0',
      ]),
      'CREATE INDEX ASYNC advances_employee_given ON advances (employee_id, given_on)',
    ],
  },
  {
    // Patient rights requests under the DPDP Act (api-list.md RightsRequest, #332). status: open / closed.
    // requested_by is the Cognito sub of the patient-portal user who filed it. The response fields are set when
    // the compliance officer responds (#333).
    id: '0094_rights_requests',
    statements: () => [
      ...createTable('rights_requests', [
        'patient_id uuid NOT NULL',
        'kind text NOT NULL',
        'text text NOT NULL',
        'requested_by text',
        'response text',
        'outcome text',
        'outcome_reason text',
        'responded_at timestamptz',
        'responded_by text',
      ]),
      'CREATE INDEX ASYNC rights_requests_status_created ON rights_requests (status, created_at)',
      'CREATE INDEX ASYNC rights_requests_patient_created ON rights_requests (patient_id, created_at)',
    ],
  },
  {
    // Legal holds on a patient's record (api-list.md LegalHold, #337). status: active / released. placed_by and
    // released_by are Cognito subs. The S3 object-lock on the patient's files is infra work, done later.
    id: '0095_legal_holds',
    statements: () => [
      ...createTable('legal_holds', [
        'patient_id uuid NOT NULL',
        'reason text NOT NULL',
        'reference text',
        'placed_by text',
        'released_at timestamptz',
        'released_by text',
        'release_reason text',
      ]),
      'CREATE INDEX ASYNC legal_holds_status_created ON legal_holds (status, created_at)',
      'CREATE INDEX ASYNC legal_holds_patient_created ON legal_holds (patient_id, created_at)',
    ],
  },
  {
    // Monthly access reviews (api-list.md AccessReview, #342). One per month; findings is a JSON array of strings
    // as text. reviewed_by is a Cognito sub.
    id: '0096_access_reviews',
    statements: () => [
      ...createTable('access_reviews', ['month text NOT NULL', 'notes text NOT NULL', 'findings text NOT NULL', 'reviewed_by text']),
      'CREATE UNIQUE INDEX ASYNC access_reviews_month ON access_reviews (month)',
    ],
  },
];
