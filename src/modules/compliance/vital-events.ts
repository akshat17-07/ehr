import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord, voidRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { UUID } from '../users/users.js';

// Births and deaths (RBD Act 1969 as amended 2023, MP RBD Rules 2024; api-list.md #330). The hospital reports each
// one to the Registrar within 21 days; a death needs the cause of death (MCCD) from the certifying doctor.
// Records are voided, never deleted; every edit keeps the old row (births_versions / deaths_versions).

export const REPORT_DAYS = 21;
const YEAR_MS = 366 * 86_400_000;
const CLINICAL_TYPES = ['doctor', 'head_doctor', 'nurse'];
const DOCTOR_TYPES = ['doctor', 'head_doctor'];

export const SEXES = ['M', 'F', 'O'] as const;
export const OUTCOMES = ['live', 'still'] as const;
export const DELIVERIES = ['normal', 'caesarean', 'assisted'] as const;
export const MANNERS = ['natural', 'accident', 'suicide', 'homicide', 'pending_investigation'] as const;

const when = z.iso.datetime({ offset: true });
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const ICD10 = /^[A-Z]\d{2}(\.\d{1,2})?$/;

// ---- input schemas (strict). Optional fields may be null on PATCH to clear them.

const birthFields = {
  bornAt: when,
  sex: z.enum(SEXES),
  weightGrams: z.number().int().min(300).max(7000),
  outcome: z.enum(OUTCOMES),
  delivery: z.enum(DELIVERIES),
  birthOrder: z.number().int().min(1).max(8),
  gestationWeeks: z.number().int().min(20).max(45),
  deliveredBy: z.uuid(),
  encounterId: z.uuid(),
  babyPatientId: z.uuid(),
  note: text(1, 500),
};
export const newBirth = z
  .object({
    motherPatientId: z.uuid(),
    bornAt: birthFields.bornAt,
    sex: birthFields.sex,
    outcome: birthFields.outcome,
    delivery: birthFields.delivery,
    deliveredBy: birthFields.deliveredBy,
    weightGrams: birthFields.weightGrams.optional(),
    birthOrder: birthFields.birthOrder.optional(),
    gestationWeeks: birthFields.gestationWeeks.optional(),
    encounterId: birthFields.encounterId.optional(),
    babyPatientId: birthFields.babyPatientId.optional(),
    note: birthFields.note.optional(),
  })
  .strict();
export const birthChange = z
  .object({
    version: z.number().int().min(1),
    reason: text(5, 500),
    bornAt: birthFields.bornAt.optional(),
    sex: birthFields.sex.optional(),
    outcome: birthFields.outcome.optional(),
    delivery: birthFields.delivery.optional(),
    deliveredBy: birthFields.deliveredBy.optional(),
    birthOrder: birthFields.birthOrder.optional(),
    weightGrams: birthFields.weightGrams.nullable().optional(),
    gestationWeeks: birthFields.gestationWeeks.nullable().optional(),
    encounterId: birthFields.encounterId.nullable().optional(),
    babyPatientId: birthFields.babyPatientId.nullable().optional(),
    note: birthFields.note.nullable().optional(),
    reportedAt: when.nullable().optional(),
    registrarRef: text(1, 100).nullable().optional(),
  })
  .strict();

const deathFields = {
  diedAt: when,
  immediateCause: text(3, 300),
  antecedentCauses: z.array(text(3, 300)).max(3),
  otherConditions: text(1, 500),
  icd10: z.array(z.string().regex(ICD10)).max(5),
  manner: z.enum(MANNERS),
  mlc: z.boolean(),
  certifiedBy: z.uuid(),
  encounterId: z.uuid(),
  admissionId: z.uuid(),
};
export const newDeath = z
  .object({
    patientId: z.uuid(),
    diedAt: deathFields.diedAt,
    immediateCause: deathFields.immediateCause,
    manner: deathFields.manner,
    mlc: deathFields.mlc,
    certifiedBy: deathFields.certifiedBy,
    antecedentCauses: deathFields.antecedentCauses.optional(),
    otherConditions: deathFields.otherConditions.optional(),
    icd10: deathFields.icd10.optional(),
    encounterId: deathFields.encounterId.optional(),
    admissionId: deathFields.admissionId.optional(),
  })
  .strict();
export const deathChange = z
  .object({
    version: z.number().int().min(1),
    reason: text(5, 500),
    diedAt: deathFields.diedAt.optional(),
    immediateCause: deathFields.immediateCause.optional(),
    manner: deathFields.manner.optional(),
    mlc: deathFields.mlc.optional(),
    certifiedBy: deathFields.certifiedBy.optional(),
    antecedentCauses: deathFields.antecedentCauses.nullable().optional(),
    otherConditions: deathFields.otherConditions.nullable().optional(),
    icd10: deathFields.icd10.nullable().optional(),
    encounterId: deathFields.encounterId.nullable().optional(),
    admissionId: deathFields.admissionId.nullable().optional(),
    reportedAt: when.nullable().optional(),
    registrarRef: text(1, 100).nullable().optional(),
  })
  .strict();

export type NewBirth = z.infer<typeof newBirth>;
export type BirthChange = z.infer<typeof birthChange>;
export type NewDeath = z.infer<typeof newDeath>;
export type DeathChange = z.infer<typeof deathChange>;

// ---- output

type Row = Record<string, unknown>;
const opt = (v: unknown) => (v == null ? undefined : String(v));
const iso = (v: unknown) => (v as Date).toISOString();

export function toBirth(r: Row) {
  return {
    ...baseFields(r as unknown as BaseRow),
    motherPatientId: String(r.mother_patient_id),
    bornAt: iso(r.born_at),
    sex: String(r.sex),
    ...(r.weight_grams != null && { weightGrams: Number(r.weight_grams) }),
    outcome: String(r.outcome),
    delivery: String(r.delivery),
    birthOrder: Number(r.birth_order),
    ...(r.gestation_weeks != null && { gestationWeeks: Number(r.gestation_weeks) }),
    deliveredBy: String(r.delivered_by),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    ...(r.baby_patient_id != null && { babyPatientId: String(r.baby_patient_id) }),
    ...(r.note != null && { note: String(r.note) }),
    ...(r.reported_at != null && { reportedAt: iso(r.reported_at) }),
    ...(r.registrar_ref != null && { registrarRef: String(r.registrar_ref) }),
  };
}
export type Birth = ReturnType<typeof toBirth>;

export function toDeath(r: Row) {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    diedAt: iso(r.died_at),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    ...(r.admission_id != null && { admissionId: String(r.admission_id) }),
    immediateCause: String(r.immediate_cause),
    antecedentCauses: r.antecedent_causes == null ? [] : (JSON.parse(String(r.antecedent_causes)) as string[]),
    ...(r.other_conditions != null && { otherConditions: String(r.other_conditions) }),
    icd10: r.icd10 == null ? [] : (JSON.parse(String(r.icd10)) as string[]),
    manner: String(r.manner),
    mlc: r.mlc === true,
    certifiedBy: String(r.certified_by),
    ...(r.reported_at != null && { reportedAt: iso(r.reported_at) }),
    ...(r.registrar_ref != null && { registrarRef: String(r.registrar_ref) }),
  };
}
export type Death = ReturnType<typeof toDeath>;

// ---- checks

const invalid = (field: string, why: string) => new AppError(422, 'invalid_input', `${field}: ${why}`);

/** A time that is not in the future and not older than a year. */
function checkRecent(field: string, value: string, now: Date): void {
  const t = Date.parse(value);
  if (t > now.getTime()) throw invalid(field, 'cannot be in the future');
  if (t < now.getTime() - YEAR_MS) throw invalid(field, 'cannot be more than a year ago');
}

/** An active staff user (users.id) of one of the types. */
async function checkStaff(db: Queryable, field: string, id: string, types: string[]): Promise<void> {
  const { rows } = await db.query('SELECT type, active FROM users WHERE id = $1 AND voided_at IS NULL', [id]);
  const user = rows[0];
  if (!user || user.active !== true) throw invalid(field, 'no such active staff member');
  if (!types.includes(String(user.type))) throw invalid(field, `must be ${types.join(' or ').replace('_', ' ')}`);
}

async function checkPatient(db: Queryable, field: string, id: string, sex?: string): Promise<void> {
  const { rows } = await db.query('SELECT sex, voided_at FROM patients WHERE id = $1', [id]);
  const p = rows[0];
  if (!p || p.voided_at != null) throw invalid(field, 'no such patient');
  if (sex && p.sex !== sex) throw invalid(field, sex === 'F' ? 'the mother must be a female patient' : 'wrong sex');
}

async function checkExists(db: Queryable, field: string, table: string, id: string): Promise<void> {
  if (!(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows[0]) throw invalid(field, 'no such record');
}

const list = (v: string[] | null | undefined) => (v == null ? null : JSON.stringify(v));

// ---- births

export async function getBirth(db: Queryable, id: string): Promise<Birth> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM births WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such birth record');
  return toBirth(rows[0]);
}

export async function recordBirth(db: Queryable, input: NewBirth, by: string, now = new Date()): Promise<Birth> {
  checkRecent('bornAt', input.bornAt, now);
  await checkPatient(db, 'motherPatientId', input.motherPatientId, 'F');
  await checkStaff(db, 'deliveredBy', input.deliveredBy, CLINICAL_TYPES);
  if (input.encounterId) await checkExists(db, 'encounterId', 'encounters', input.encounterId);
  if (input.babyPatientId) await checkPatient(db, 'babyPatientId', input.babyPatientId);
  const { rows } = await db.query(
    `INSERT INTO births (id, status, created_by, updated_by, mother_patient_id, born_at, sex, weight_grams, outcome, delivery, birth_order,
                         gestation_weeks, delivered_by, encounter_id, baby_patient_id, note)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      randomUUID(), by, input.motherPatientId, new Date(input.bornAt), input.sex, input.weightGrams ?? null, input.outcome, input.delivery,
      input.birthOrder ?? 1, input.gestationWeeks ?? null, input.deliveredBy, input.encounterId ?? null, input.babyPatientId ?? null, input.note ?? null,
    ],
  );
  return toBirth(rows[0]!);
}

export async function changeBirth(db: Queryable, id: string, input: BirthChange, by: string, now = new Date()): Promise<Birth> {
  const current = await getBirth(db, id);
  if (current.voidedAt) throw new AppError(409, 'voided', 'this record is voided');
  const set: Record<string, unknown> = {};
  if (input.bornAt) {
    checkRecent('bornAt', input.bornAt, now);
    set.born_at = new Date(input.bornAt);
  }
  if (input.deliveredBy) {
    await checkStaff(db, 'deliveredBy', input.deliveredBy, CLINICAL_TYPES);
    set.delivered_by = input.deliveredBy;
  }
  if (input.encounterId) await checkExists(db, 'encounterId', 'encounters', input.encounterId);
  if (input.babyPatientId) await checkPatient(db, 'babyPatientId', input.babyPatientId);
  const map: [keyof BirthChange, string, (v: never) => unknown][] = [
    ['sex', 'sex', (v) => v], ['outcome', 'outcome', (v) => v], ['delivery', 'delivery', (v) => v], ['birthOrder', 'birth_order', (v) => v],
    ['weightGrams', 'weight_grams', (v) => v], ['gestationWeeks', 'gestation_weeks', (v) => v], ['encounterId', 'encounter_id', (v) => v],
    ['babyPatientId', 'baby_patient_id', (v) => v], ['note', 'note', (v) => v], ['registrarRef', 'registrar_ref', (v) => v],
    ['reportedAt', 'reported_at', (v: string | null) => (v == null ? null : new Date(v))],
  ];
  for (const [key, column, convert] of map) if (input[key] !== undefined) set[column] = convert(input[key] as never);
  if (Object.keys(set).length === 0) throw invalid('body', 'nothing to change');
  return toBirth(await updateRecord(db, 'births', { id, version: input.version, by, reason: input.reason, set }));
}

export async function voidBirth(db: Queryable, id: string, reason: string, by: string): Promise<Birth> {
  const current = await getBirth(db, id);
  return toBirth(await voidRecord(db, 'births', { id, version: current.version, by, reason }));
}

// ---- deaths

export async function getDeath(db: Queryable, id: string): Promise<Death> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM deaths WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such death record');
  return toDeath(rows[0]);
}

export async function recordDeath(db: Queryable, input: NewDeath, by: string, now = new Date()): Promise<Death> {
  checkRecent('diedAt', input.diedAt, now);
  await checkPatient(db, 'patientId', input.patientId);
  // MCCD (cause of death) is signed by a doctor, not a nurse.
  await checkStaff(db, 'certifiedBy', input.certifiedBy, DOCTOR_TYPES);
  if (input.encounterId) await checkExists(db, 'encounterId', 'encounters', input.encounterId);
  if (input.admissionId) await checkExists(db, 'admissionId', 'admissions', input.admissionId);
  const known = await db.query('SELECT 1 FROM deaths WHERE patient_id = $1 AND voided_at IS NULL', [input.patientId]);
  if (known.rows[0]) throw new AppError(409, 'already_recorded', 'a death is already recorded for this patient');
  const { rows } = await db.query(
    `INSERT INTO deaths (id, status, created_by, updated_by, patient_id, died_at, encounter_id, admission_id, immediate_cause, antecedent_causes,
                         other_conditions, icd10, manner, mlc, certified_by)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      randomUUID(), by, input.patientId, new Date(input.diedAt), input.encounterId ?? null, input.admissionId ?? null, input.immediateCause,
      list(input.antecedentCauses), input.otherConditions ?? null, list(input.icd10), input.manner, input.mlc, input.certifiedBy,
    ],
  );
  return toDeath(rows[0]!);
}

export async function changeDeath(db: Queryable, id: string, input: DeathChange, by: string, now = new Date()): Promise<Death> {
  const current = await getDeath(db, id);
  if (current.voidedAt) throw new AppError(409, 'voided', 'this record is voided');
  const set: Record<string, unknown> = {};
  if (input.diedAt) {
    checkRecent('diedAt', input.diedAt, now);
    set.died_at = new Date(input.diedAt);
  }
  if (input.certifiedBy) {
    await checkStaff(db, 'certifiedBy', input.certifiedBy, DOCTOR_TYPES);
    set.certified_by = input.certifiedBy;
  }
  if (input.encounterId) await checkExists(db, 'encounterId', 'encounters', input.encounterId);
  if (input.admissionId) await checkExists(db, 'admissionId', 'admissions', input.admissionId);
  const map: [keyof DeathChange, string, (v: never) => unknown][] = [
    ['immediateCause', 'immediate_cause', (v) => v], ['manner', 'manner', (v) => v], ['mlc', 'mlc', (v) => v],
    ['otherConditions', 'other_conditions', (v) => v], ['encounterId', 'encounter_id', (v) => v], ['admissionId', 'admission_id', (v) => v],
    ['registrarRef', 'registrar_ref', (v) => v], ['antecedentCauses', 'antecedent_causes', (v: string[] | null) => list(v)],
    ['icd10', 'icd10', (v: string[] | null) => list(v)], ['reportedAt', 'reported_at', (v: string | null) => (v == null ? null : new Date(v))],
  ];
  for (const [key, column, convert] of map) if (input[key] !== undefined) set[column] = convert(input[key] as never);
  if (Object.keys(set).length === 0) throw invalid('body', 'nothing to change');
  return toDeath(await updateRecord(db, 'deaths', { id, version: input.version, by, reason: input.reason, set }));
}

export async function voidDeath(db: Queryable, id: string, reason: string, by: string): Promise<Death> {
  const current = await getDeath(db, id);
  return toDeath(await voidRecord(db, 'deaths', { id, version: current.version, by, reason }));
}

// ---- #330 register

const MAX_DAYS = 366;
export const registerQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), kind: z.enum(['birth', 'death']).optional() })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_DAYS, { message: 'at most 366 days' });

export interface VitalEventRow {
  kind: 'birth' | 'death';
  id: string;
  date: string;
  at: string;
  patientId: string;
  uhid: string;
  patientName: string;
  /** The last day to report to the Registrar: the event date + 21 days. */
  dueBy: string;
  reported: boolean;
  registrarRef?: string;
  details: Record<string, unknown>;
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** #330: births and deaths in the India-time days from..to, oldest first. Voided ones are left out. */
export async function birthsDeaths(db: Queryable, q: z.infer<typeof registerQuery>): Promise<VitalEventRow[]> {
  const start = indiaDayStart(q.from);
  const end = indiaDayStart(addDays(q.to, 1));
  const out: VitalEventRow[] = [];
  if (q.kind !== 'death') {
    const { rows } = await db.query(
      `SELECT b.*, p.uhid, p.name AS patient_name, u.name AS delivered_by_name
       FROM births b LEFT JOIN patients p ON p.id = b.mother_patient_id LEFT JOIN users u ON u.id = b.delivered_by
       WHERE b.voided_at IS NULL AND b.born_at >= $1 AND b.born_at < $2`,
      [start, end],
    );
    for (const r of rows) {
      const birth = toBirth(r);
      const date = indiaDate(r.born_at as Date);
      out.push({
        kind: 'birth', id: birth.id, date, at: birth.bornAt, patientId: birth.motherPatientId,
        uhid: String(r.uhid ?? ''), patientName: String(r.patient_name ?? ''), dueBy: addDays(date, REPORT_DAYS),
        reported: r.reported_at != null, ...(birth.registrarRef && { registrarRef: birth.registrarRef }),
        details: {
          sex: birth.sex, outcome: birth.outcome, delivery: birth.delivery, birthOrder: birth.birthOrder,
          ...(birth.weightGrams != null && { weightGrams: birth.weightGrams }),
          ...(birth.gestationWeeks != null && { gestationWeeks: birth.gestationWeeks }),
          deliveredBy: { id: birth.deliveredBy, name: opt(r.delivered_by_name) ?? null },
          ...(birth.encounterId && { encounterId: birth.encounterId }),
          ...(birth.babyPatientId && { babyPatientId: birth.babyPatientId }),
          ...(birth.note && { note: birth.note }),
        },
      });
    }
  }
  if (q.kind !== 'birth') {
    const { rows } = await db.query(
      `SELECT d.*, p.uhid, p.name AS patient_name, u.name AS certified_by_name
       FROM deaths d LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN users u ON u.id = d.certified_by
       WHERE d.voided_at IS NULL AND d.died_at >= $1 AND d.died_at < $2`,
      [start, end],
    );
    for (const r of rows) {
      const death = toDeath(r);
      const date = indiaDate(r.died_at as Date);
      out.push({
        kind: 'death', id: death.id, date, at: death.diedAt, patientId: death.patientId,
        uhid: String(r.uhid ?? ''), patientName: String(r.patient_name ?? ''), dueBy: addDays(date, REPORT_DAYS),
        reported: r.reported_at != null, ...(death.registrarRef && { registrarRef: death.registrarRef }),
        details: {
          immediateCause: death.immediateCause, antecedentCauses: death.antecedentCauses,
          ...(death.otherConditions && { otherConditions: death.otherConditions }),
          icd10: death.icd10, manner: death.manner, mlc: death.mlc,
          certifiedBy: { id: death.certifiedBy, name: opt(r.certified_by_name) ?? null },
          ...(death.encounterId && { encounterId: death.encounterId }),
          ...(death.admissionId && { admissionId: death.admissionId }),
        },
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
