import type { Queryable } from '../../db/migrate.js';
import type { RxLine } from '../prescriptions/rx-checks.js';
import { getHospital } from '../reference/hospital.js';
import { getPatient } from '../patients/patients.js';
import type { RecordRequest } from './record-requests.js';

// The record copy a patient gets (#147): one HTML page to read or print. scope full: allergies, problems, every
// visit and the document list; encounter: only the chosen visits; documents: only the document list. Visits show
// final and provisional diagnoses, signed notes and confirmed prescriptions; voided entries are left out.

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '<p>None recorded.</p>');
const ids = (n: number, from = 2) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(', ');

type Row = Record<string, unknown>;

async function rowsFor(db: Queryable, table: string, patientId: string, encounterIds: string[] | undefined, extra = ''): Promise<Row[]> {
  if (encounterIds?.length === 0) return [];
  const filter = encounterIds ? ` AND encounter_id IN (${ids(encounterIds.length)})` : '';
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE patient_id = $1 AND voided_at IS NULL${extra}${filter} ORDER BY created_at, id`, [
    patientId,
    ...(encounterIds ?? []),
  ]);
  return rows;
}

function byEncounter(rows: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const r of rows) map.set(String(r.encounter_id), [...(map.get(String(r.encounter_id)) ?? []), r]);
  return map;
}

async function visitsHtml(db: Queryable, patientId: string, encounterIds?: string[]): Promise<string> {
  const filter = encounterIds ? ` AND e.id IN (${ids(encounterIds.length)})` : '';
  const { rows: visits } = await db.query(
    `SELECT e.*, d.name_en AS department, u.name AS doctor FROM encounters e
     LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = e.doctor_id
     WHERE e.patient_id = $1 AND e.voided_at IS NULL${filter} ORDER BY e.started_at, e.id`,
    [patientId, ...(encounterIds ?? [])],
  );
  const visitIds = visits.map((v) => String(v.id));
  const diagnoses = byEncounter(await rowsFor(db, 'diagnoses', patientId, visitIds));
  const notes = byEncounter(await rowsFor(db, 'notes', patientId, visitIds, ' AND signed_at IS NOT NULL'));
  const rx = byEncounter(await rowsFor(db, 'prescriptions', patientId, visitIds, " AND status IN ('confirmed', 'dispensed')"));
  if (visits.length === 0) return '<h2>Visits</h2><p>None recorded.</p>';
  return (
    '<h2>Visits</h2>' +
    visits
      .map((v) => {
        const id = String(v.id);
        const dx = (diagnoses.get(id) ?? []).map((d) => `${escape(String(d.icd10))} ${escape(String(d.text))} (${escape(String(d.kind))})`);
        const nx = (notes.get(id) ?? []).map((n) => `<b>${escape(String(n.kind))}</b>: ${escape(String(n.text))}`);
        const lines = (rx.get(id) ?? []).flatMap((p) => JSON.parse(String(p.lines)) as RxLine[]);
        const rl = lines.map((l) => escape([l.drugText, l.strength, l.dose, l.frequency, `${l.days} days`, l.instructions].filter(Boolean).join(' · ')));
        return `<section><h3>${day(v.started_at as Date)} · ${escape(String(v.type))} · ${escape(String(v.department ?? ''))} · ${escape(String(v.doctor ?? ''))}</h3>
<h4>Diagnoses</h4>${list(dx)}<h4>Notes</h4>${list(nx)}<h4>Prescriptions</h4>${list(rl)}</section>`;
      })
      .join('')
  );
}

export async function recordCopyHtml(db: Queryable, request: RecordRequest, now = new Date()): Promise<string> {
  const [hospital, patient] = await Promise.all([getHospital(db), getPatient(db, request.patientId)]);
  const parts: string[] = [];
  if (request.scope === 'full') {
    const allergies = await rowsFor(db, 'allergies', patient.id, undefined);
    const problems = await rowsFor(db, 'problems', patient.id, undefined);
    parts.push(`<h2>Allergies</h2>${list(allergies.map((a) => escape([a.substance, a.reaction, a.severity].filter((x) => x != null).join(' · '))))}`);
    parts.push(`<h2>Problems</h2>${list(problems.map((p) => escape(String(p.text)) + (p.resolved_at != null ? ' (resolved)' : '')))}`);
  }
  if (request.scope !== 'documents') parts.push(await visitsHtml(db, patient.id, request.scope === 'encounter' ? (request.encounterIds ?? []) : undefined));
  if (request.scope !== 'encounter') {
    const { rows: docs } = await db.query("SELECT * FROM documents WHERE patient_id = $1 AND status = 'ready' ORDER BY created_at, id", [patient.id]);
    parts.push(`<h2>Documents</h2>${list(docs.map((d) => `${day(d.created_at as Date)} · ${escape(String(d.type))} · ${escape(String(d.file_name))}`))}`);
  }
  const age = patient.ageYears != null ? ` · ${patient.ageYears} y` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Record copy ${escape(patient.uhid)}</title>
<style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:16px}h3{margin-bottom:0}section{border-top:1px solid #ccc}</style></head>
<body><h1>${escape(hospital.name)}</h1><p>${escape(hospital.phone)} · ${escape(hospital.email)}</p>
<p><b>Record copy</b> for ${escape(patient.name)} (UHID ${escape(patient.uhid)}) · ${escape(patient.sex)}${age} · made ${day(now)}</p>
${parts.join('\n')}
</body></html>`;
}
