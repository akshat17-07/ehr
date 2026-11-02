import type { Queryable } from '../../db/migrate.js';
import type { RxLine } from '../prescriptions/rx-checks.js';
import { getPatient, type Patient } from '../patients/patients.js';

// A patient's record as a FHIR R4 Bundle (type collection), so another hospital or app can read it: Patient,
// Encounter, Condition (ICD-10), MedicationRequest (one per prescription line), AllergyIntolerance and
// DocumentReference (the list only; files stay in S3). Voided entries are left out.

type Resource = Record<string, unknown> & { resourceType: string; id: string };
type Row = Record<string, unknown>;

const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const ENCOUNTER_CLASS: Record<string, { code: string; display: string }> = {
  OPD: { code: 'AMB', display: 'ambulatory' },
  IPD: { code: 'IMP', display: 'inpatient encounter' },
  ER: { code: 'EMER', display: 'emergency' },
};
const GENDER: Record<string, string> = { M: 'male', F: 'female', O: 'other' };
const iso = (v: unknown) => (v as Date).toISOString();
const ref = (type: string, id: unknown) => ({ reference: `${type}/${String(id)}` });

function patientResource(p: Patient): Resource {
  const telecom = [...(p.mobile ? [{ system: 'phone', value: p.mobile }] : []), ...(p.email ? [{ system: 'email', value: p.email }] : [])];
  return {
    resourceType: 'Patient',
    id: p.id,
    identifier: [{ system: 'urn:ehr:uhid', value: p.uhid }],
    active: !p.inactive,
    name: [{ text: p.name }],
    gender: GENDER[p.sex] ?? 'unknown',
    ...(p.dob && { birthDate: p.dob }),
    ...(telecom.length > 0 && { telecom }),
  };
}

async function rows(db: Queryable, sql: string, patientId: string): Promise<Row[]> {
  return (await db.query(sql, [patientId])).rows;
}

export async function patientBundle(db: Queryable, patientId: string, now = new Date()): Promise<Record<string, unknown>> {
  const patient = await getPatient(db, patientId);
  const live = 'WHERE patient_id = $1 AND voided_at IS NULL ORDER BY created_at, id';
  const [encounters, diagnoses, prescriptions, allergies, documents] = await Promise.all([
    rows(db, 'SELECT * FROM encounters WHERE patient_id = $1 AND voided_at IS NULL ORDER BY started_at, id', patient.id),
    rows(db, `SELECT * FROM diagnoses ${live}`, patient.id),
    rows(db, `SELECT * FROM prescriptions WHERE patient_id = $1 AND status IN ('confirmed', 'dispensed') ORDER BY created_at, id`, patient.id),
    rows(db, `SELECT * FROM allergies ${live}`, patient.id),
    rows(db, "SELECT * FROM documents WHERE patient_id = $1 AND status = 'ready' ORDER BY created_at, id", patient.id),
  ]);
  const subject = ref('Patient', patient.id);
  const resources: Resource[] = [
    patientResource(patient),
    ...encounters.map((e) => ({
      resourceType: 'Encounter',
      id: String(e.id),
      status: e.closed_at != null ? 'finished' : 'in-progress',
      class: { system: ACT_CODE, ...(ENCOUNTER_CLASS[String(e.type)] ?? { code: 'AMB', display: 'ambulatory' }) },
      subject,
      period: { start: iso(e.started_at), ...(e.closed_at != null && { end: iso(e.closed_at) }) },
    })),
    ...diagnoses.map((d) => ({
      resourceType: 'Condition',
      id: String(d.id),
      verificationStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: d.kind === 'final' ? 'confirmed' : 'provisional' }],
      },
      code: { coding: [{ system: ICD10, code: String(d.icd10), display: String(d.text) }], text: String(d.text) },
      subject,
      encounter: ref('Encounter', d.encounter_id),
      recordedDate: iso(d.created_at),
    })),
    ...prescriptions.flatMap((rx) =>
      (JSON.parse(String(rx.lines)) as RxLine[]).map((l, i) => ({
        resourceType: 'MedicationRequest',
        id: `${String(rx.id)}-${i + 1}`,
        status: rx.status === 'dispensed' ? 'completed' : 'active',
        intent: 'order',
        medicationCodeableConcept: { text: [l.drugText, l.strength, l.form].filter(Boolean).join(' ') },
        subject,
        encounter: ref('Encounter', rx.encounter_id),
        authoredOn: iso(rx.created_at),
        dosageInstruction: [{ text: [l.dose, l.frequency, l.route, `${l.days} days`, l.instructions].filter(Boolean).join(', ') }],
      })),
    ),
    ...allergies.map((a) => ({
      resourceType: 'AllergyIntolerance',
      id: String(a.id),
      code: { text: String(a.substance) },
      patient: subject,
      criticality: a.severity === 'severe' ? 'high' : 'low',
      ...(a.reaction != null && { reaction: [{ manifestation: [{ text: String(a.reaction) }] }] }),
    })),
    ...documents.map((d) => ({
      resourceType: 'DocumentReference',
      id: String(d.id),
      status: 'current',
      type: { text: String(d.type) },
      subject,
      date: iso(d.created_at),
      content: [{ attachment: { contentType: String(d.mime), title: String(d.file_name) } }],
    })),
  ];
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: now.toISOString(),
    entry: resources.map((resource) => ({ fullUrl: `urn:ehr:${resource.resourceType}/${resource.id}`, resource })),
  };
}
