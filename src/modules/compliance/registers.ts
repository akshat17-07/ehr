import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';

// Statutory registers for the compliance officer (api-list.md rows 217, 219). Read only.

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const day = (v: unknown): string => indiaDate(v instanceof Date ? v : new Date(String(v)));

export const pcpndtQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();

export interface PcpndtRow {
  formFId: string;
  date: string;
  encounterId: string;
  patientId: string;
  uhid: string;
  patientName: string;
  doctorId: string;
  doctorName: string | null;
  indication: string;
  procedure: string;
  declarationSigned: boolean;
  documentId: string | null;
}

/** #329: the Forms F written in an India-time month. There is no fetal-sex field anywhere (PC-PNDT Act). */
export async function pcpndtMonthly(db: Queryable, month: string): Promise<{ month: string; rows: PcpndtRow[] }> {
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const { rows } = await db.query(
    `SELECT f.id, f.created_at, f.encounter_id, f.patient_id, f.doctor_id, f.indication, f.procedure, f.declaration_signed, f.document_id,
            p.uhid, p.name AS patient_name, u.name AS doctor_name
     FROM form_f f
     LEFT JOIN patients p ON p.id = f.patient_id
     LEFT JOIN users u ON u.id = f.doctor_id
     WHERE f.voided_at IS NULL AND f.created_at >= $1 AND f.created_at < $2
     ORDER BY f.created_at, f.id`,
    [indiaDayStart(first), indiaDayStart(next)],
  );
  return {
    month,
    rows: rows.map((r) => ({
      formFId: String(r.id),
      date: day(r.created_at),
      encounterId: String(r.encounter_id),
      patientId: String(r.patient_id),
      uhid: String(r.uhid ?? ''),
      patientName: String(r.patient_name ?? ''),
      doctorId: String(r.doctor_id),
      doctorName: r.doctor_name == null ? null : String(r.doctor_name),
      indication: String(r.indication),
      procedure: String(r.procedure),
      declarationSigned: Boolean(r.declaration_signed),
      documentId: r.document_id == null ? null : String(r.document_id),
    })),
  };
}

/** India's notifiable diseases (IDSP), by ICD-10 code prefix. Ranges are listed code by code. */
const range = (letter: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${letter}${String(from + i).padStart(2, '0')}`);
export const NOTIFIABLE: { prefix: string; disease: string }[] = [
  { prefix: 'A00', disease: 'Cholera' },
  { prefix: 'A01', disease: 'Typhoid / enteric fever' },
  { prefix: 'A09', disease: 'Acute diarrhoeal disease' },
  ...range('A', 15, 19).map((prefix) => ({ prefix, disease: 'Tuberculosis' })),
  { prefix: 'A20', disease: 'Plague' },
  { prefix: 'A27', disease: 'Leptospirosis' },
  { prefix: 'A30', disease: 'Leprosy' },
  ...range('A', 33, 35).map((prefix) => ({ prefix, disease: 'Tetanus' })),
  { prefix: 'A36', disease: 'Diphtheria' },
  { prefix: 'A37', disease: 'Pertussis' },
  { prefix: 'A39', disease: 'Meningococcal infection' },
  { prefix: 'A80', disease: 'Acute flaccid paralysis / Polio' },
  { prefix: 'A82', disease: 'Rabies' },
  { prefix: 'A83.0', disease: 'Japanese encephalitis' },
  ...range('A', 90, 91).map((prefix) => ({ prefix, disease: 'Dengue' })),
  { prefix: 'A92.0', disease: 'Chikungunya' },
  { prefix: 'A95', disease: 'Yellow fever' },
  { prefix: 'B05', disease: 'Measles' },
  { prefix: 'B06', disease: 'Rubella' },
  { prefix: 'B15', disease: 'Hepatitis A' },
  { prefix: 'B16', disease: 'Hepatitis B' },
  { prefix: 'B17.2', disease: 'Hepatitis E' },
  ...range('B', 20, 24).map((prefix) => ({ prefix, disease: 'HIV' })),
  ...range('B', 50, 54).map((prefix) => ({ prefix, disease: 'Malaria' })),
  { prefix: 'B55', disease: 'Kala-azar' },
  { prefix: 'B74', disease: 'Filariasis' },
  { prefix: 'U07.1', disease: 'COVID-19' },
];

const MAX_DAYS = 366;
export const notifiableQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_DAYS, { message: 'at most 366 days' });

export interface NotifiableRow {
  date: string;
  patientId: string;
  uhid: string;
  patientName: string;
  encounterId: string;
  icd10: string;
  disease: string;
  diagnosisText: string;
  kind: string;
}

/** #331: diagnoses coded to a notifiable disease, by India-time date in [from, to]. */
export async function notifiableDiseases(db: Queryable, q: { from: string; to: string }): Promise<NotifiableRow[]> {
  const prefixes = [...new Set(NOTIFIABLE.map((n) => n.prefix))];
  const { rows } = await db.query(
    `SELECT d.id, d.created_at, d.patient_id, d.encounter_id, d.icd10, d.text, d.kind, p.uhid, p.name AS patient_name
     FROM diagnoses d LEFT JOIN patients p ON p.id = d.patient_id
     WHERE d.voided_at IS NULL AND d.created_at >= $1 AND d.created_at < $2
       AND (${prefixes.map((_, i) => `UPPER(d.icd10) LIKE $${i + 3}`).join(' OR ')})
     ORDER BY d.created_at, d.id`,
    [indiaDayStart(q.from), indiaDayStart(addDays(q.to, 1)), ...prefixes.map((p) => `${p}%`)],
  );
  const out: NotifiableRow[] = [];
  for (const r of rows) {
    const code = String(r.icd10).toUpperCase();
    const hit = NOTIFIABLE.filter((n) => code.startsWith(n.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!hit) continue;
    out.push({
      date: day(r.created_at),
      patientId: String(r.patient_id),
      uhid: String(r.uhid ?? ''),
      patientName: String(r.patient_name ?? ''),
      encounterId: String(r.encounter_id),
      icd10: String(r.icd10),
      disease: hit.disease,
      diagnosisText: String(r.text),
      kind: String(r.kind),
    });
  }
  return out;
}
