import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import { getHospital, type Address } from '../reference/hospital.js';
import { toDocument, type Document, type DocumentType } from '../documents/documents.js';
import { getPatient, updatePatient, type Patient } from '../patients/patients.js';
import { toEncounter, type EncounterStatus, type EncounterType } from '../encounters/encounters.js';
import { encounterVitals, VITAL_FIELDS, type Vital } from '../encounters/vitals.js';
import { toPrescription, type Prescription, type RxSource, type RxStatus } from '../prescriptions/prescriptions.js';
import type { RxLine } from '../prescriptions/rx-checks.js';
import { toAppointment } from '../appointments/appointments.js';
import { toSurgery } from '../surgeries/surgeries.js';
import { getBill, toBill, type Bill, type BillLine, type BillSeries, type BillStatus } from '../billing/bills.js';
import { billPayments, type PaymentMode } from '../billing/payments.js';
import { billHtml, type PrintLanguage } from '../billing/print.js';

// Patient-portal views (api-list.md §8, #239-#241). The caller has been resolved by resolvePortalPatient; these
// functions only shape what a patient may see: no staff-only fields (who saved what, sensitive labels, staff notes,
// emergency notes, checklists, op notes, team) and never a venue payment.

/** The patient's own details as the portal shows them. */
export interface PortalPatient {
  id: string;
  version: number;
  uhid: string;
  name: string;
  sex: Patient['sex'];
  dob?: string;
  ageYears?: number;
  mobile?: string;
  email?: string;
  address?: Address;
  allergies: string[];
  updatedAt: string;
}

export function toPortalPatient(p: Patient): PortalPatient {
  return {
    id: p.id,
    version: p.version,
    uhid: p.uhid,
    name: p.name,
    sex: p.sex,
    ...(p.dob !== undefined && { dob: p.dob }),
    ...(p.ageYears !== undefined && { ageYears: p.ageYears }),
    ...(p.mobile !== undefined && { mobile: p.mobile }),
    ...(p.email !== undefined && { email: p.email }),
    ...(p.address !== undefined && { address: p.address }),
    allergies: p.allergies,
    updatedAt: p.updatedAt,
  };
}

/** #240: contact details only; name and DOB corrections go through the staff (#258). null clears a field. */
export interface PortalProfileChange {
  version: number;
  mobile?: string | null;
  email?: string | null;
  address?: Address | null;
}

export async function updatePortalProfile(db: Queryable, patientId: string, change: PortalProfileChange, by: string): Promise<PortalPatient> {
  const { version, mobile, email, address } = change;
  const patient = await updatePatient(db, patientId, { version, mobile, email, address, reason: 'patient portal' }, by);
  return toPortalPatient(patient);
}

export async function portalPatient(db: Queryable, patientId: string): Promise<PortalPatient> {
  return toPortalPatient(await getPatient(db, patientId));
}

export interface PortalAppointment {
  id: string;
  status: string;
  patientId: string;
  at: string;
  durationMin: number;
  doctorId: string;
  doctorName?: string;
  departmentId: string;
  departmentName?: string;
}

export interface PortalSurgery {
  id: string;
  status: string;
  patientId: string;
  procedure: string;
  site?: string;
  side?: string;
  scheduledAt: string;
  venue: string;
  hospitalName?: string;
  surgeonId: string;
  surgeonName?: string;
  /** The estimate charged to the patient. What we pay a partner venue is never shown. */
  chargesPaise: number;
  instructions?: string;
}

export interface PortalHome {
  nextAppointment?: PortalAppointment;
  nextSurgery?: PortalSurgery;
  /** Owed on finalised bills (final, part paid). Drafts and voided bills don't count. */
  duePaise: number;
  /** There is no patient notification store yet, so always 0. */
  unreadCount: number;
}

const opt = (v: unknown) => (v == null ? undefined : String(v));

/** #241 */
export async function portalHome(db: Queryable, patientId: string, now = new Date()): Promise<PortalHome> {
  const appt = await db.query(
    `SELECT a.*, u.name AS doctor_name, d.name_en AS department_name FROM appointments a
     LEFT JOIN users u ON u.id = a.doctor_id LEFT JOIN departments d ON d.id = a.department_id
     WHERE a.patient_id = $1 AND a.status = 'booked' AND a.voided_at IS NULL AND a.at >= $2 ORDER BY a.at, a.id LIMIT 1`,
    [patientId, now],
  );
  const surgery = await db.query(
    `SELECT s.*, u.name AS surgeon_name, h.name AS hospital_name FROM surgeries s
     LEFT JOIN users u ON u.id = s.surgeon_id LEFT JOIN partner_hospitals h ON h.id = s.partner_hospital_id
     WHERE s.patient_id = $1 AND s.status = 'scheduled' AND s.voided_at IS NULL AND s.scheduled_at >= $2
     ORDER BY s.scheduled_at, s.id LIMIT 1`,
    [patientId, now],
  );
  const due = await db.query(
    `SELECT COALESCE(SUM(total_paise - paid_paise), 0) AS due FROM bills
     WHERE patient_id = $1 AND status IN ('final', 'part_paid') AND voided_at IS NULL`,
    [patientId],
  );

  const home: PortalHome = { duePaise: Number(due.rows[0]?.due ?? 0), unreadCount: 0 };
  const ar = appt.rows[0] as Record<string, unknown> | undefined;
  if (ar) {
    const a = toAppointment(ar, now);
    home.nextAppointment = {
      id: a.id, status: a.status, patientId: a.patientId, at: a.at, durationMin: a.durationMin,
      doctorId: a.doctorId, ...(opt(ar.doctor_name) && { doctorName: String(ar.doctor_name) }),
      departmentId: a.departmentId, ...(opt(ar.department_name) && { departmentName: String(ar.department_name) }),
    };
  }
  const sr = surgery.rows[0] as Record<string, unknown> | undefined;
  if (sr) {
    const s = toSurgery(sr);
    home.nextSurgery = {
      id: s.id, status: s.status, patientId: s.patientId, procedure: s.procedure,
      ...(s.site !== undefined && { site: s.site }), ...(s.side !== undefined && { side: s.side }),
      scheduledAt: s.scheduledAt, venue: s.venue, ...(opt(sr.hospital_name) && { hospitalName: String(sr.hospital_name) }),
      surgeonId: s.surgeonId, ...(opt(sr.surgeon_name) && { surgeonName: String(sr.surgeon_name) }),
      chargesPaise: s.chargesPaise, ...(s.instructions !== undefined && { instructions: s.instructions }),
    };
  }
  return home;
}

// #242-#244: visits and prescriptions for the portal. Drafts, voided items and staff-only fields never leave here.
// A patient with any sensitive label (#187) gets no diagnoses, notes or prescriptions through the portal: those are
// where a labelled condition or drug would show. The visit summary has no clinical content, so it is always shown.

export interface PortalVisitSummary {
  id: string;
  status: EncounterStatus;
  patientId: string;
  type: EncounterType;
  departmentId: string;
  doctorId: string;
  startedAt: string;
  closedAt?: string;
}

export type PortalVital = { id: string; takenAt: string } & Partial<Record<(typeof VITAL_FIELDS)[number][0], number>>;

export interface PortalDiagnosis {
  id: string;
  icd10: string;
  text: string;
}

export interface PortalNote {
  id: string;
  kind: 'progress' | 'consult' | 'procedure';
  text: string;
  signedAt: string;
  addenda: { text: string; at: string }[];
}

export interface PortalPrescription {
  id: string;
  status: Exclude<RxStatus, 'draft' | 'void'>;
  source: RxSource;
  createdAt: string;
  lines: RxLine[];
  confirmedAt?: string;
}

export interface PortalVisitDetail extends PortalVisitSummary {
  vitals: PortalVital[];
  diagnoses: PortalDiagnosis[];
  notes: PortalNote[];
  prescriptions: PortalPrescription[];
}

export const PORTAL_PRESCRIPTION_STATUSES = ['confirmed', 'dispensed'] as const;

/** Any sensitive label on the patient hides its clinical narrative and drugs from the portal. */
export async function hasSensitiveLabel(db: Queryable, patientId: string): Promise<boolean> {
  return (await getPatient(db, patientId)).labels.length > 0;
}

export function toPortalVisit(r: Record<string, unknown>): PortalVisitSummary {
  const e = toEncounter(r);
  return {
    id: e.id,
    status: e.status,
    patientId: e.patientId,
    type: e.type,
    departmentId: e.departmentId,
    doctorId: e.doctorId,
    startedAt: e.startedAt,
    ...(e.closedAt !== undefined && { closedAt: e.closedAt }),
  };
}

/** #242: the patient's visits, newest first. */
export async function portalVisits(db: Queryable, patientId: string, query: PageQuery): Promise<Page<PortalVisitSummary>> {
  return pageRows(
    db,
    { select: 'SELECT * FROM encounters', where: ['patient_id = $1', 'voided_at IS NULL'], params: [patientId], orderBy: ['started_at', 'id'] },
    query,
    toPortalVisit,
  );
}

const portalVital = (v: Vital): PortalVital => {
  const out: PortalVital = { id: v.id, takenAt: v.takenAt };
  for (const [field] of VITAL_FIELDS) if (v[field] !== undefined) out[field] = v[field];
  return out;
};

export function toPortalPrescription(p: Prescription): PortalPrescription {
  return {
    id: p.id,
    status: p.status as PortalPrescription['status'],
    source: p.source,
    createdAt: p.createdAt,
    lines: p.lines,
    ...(p.confirmedAt !== undefined && { confirmedAt: p.confirmedAt }),
  };
}

/** #243: one visit. The caller has checked that the visit's patient is one this account may act for. */
export async function portalVisitDetail(db: Queryable, encounterId: string): Promise<PortalVisitDetail> {
  const { rows } = await db.query('SELECT * FROM encounters WHERE id = $1 AND voided_at IS NULL', [encounterId]);
  if (!rows[0]) throw new AppError(403, 'forbidden', 'not a patient this account may see');
  const visit = toPortalVisit(rows[0] as Record<string, unknown>);
  const vitals = (await encounterVitals(db, encounterId)).map(portalVital);
  if (await hasSensitiveLabel(db, visit.patientId)) return { ...visit, vitals, diagnoses: [], notes: [], prescriptions: [] };

  const diagnoses = await db.query(
    "SELECT id, icd10, text FROM diagnoses WHERE encounter_id = $1 AND kind = 'final' AND voided_at IS NULL ORDER BY created_at, id",
    [encounterId],
  );
  const notes = await db.query(
    "SELECT * FROM notes WHERE encounter_id = $1 AND status = 'signed' AND kind <> 'nursing' AND voided_at IS NULL ORDER BY created_at, id",
    [encounterId],
  );
  const rx = await db.query(
    `SELECT * FROM prescriptions WHERE encounter_id = $1 AND status IN ($2, $3) AND voided_at IS NULL ORDER BY created_at, id`,
    [encounterId, ...PORTAL_PRESCRIPTION_STATUSES],
  );
  return {
    ...visit,
    vitals,
    diagnoses: diagnoses.rows.map((r) => ({ id: String(r.id), icd10: String(r.icd10), text: String(r.text) })),
    notes: notes.rows.map((r) => {
      const addenda = JSON.parse(String(r.addenda ?? '[]')) as { text: string; at: string }[];
      return {
        id: String(r.id),
        kind: r.kind as PortalNote['kind'],
        text: String(r.text),
        signedAt: (r.signed_at as Date).toISOString(),
        addenda: addenda.map((a) => ({ text: a.text, at: a.at })),
      };
    }),
    prescriptions: rx.rows.map((r) => toPortalPrescription(toPrescription(r as Record<string, unknown>))),
  };
}

// #245, #246: documents. Only uploaded (ready), non-voided files; never a pending upload or a misfiled one. A file
// filed with a Form F (PCPNDT) or an MTP register entry is never shown: those are statutory registers. A patient with
// any sensitive label sees only administrative files (ID proof, insurance): every other type (prescription, lab
// report, imaging, consent, discharge, other) may name the labelled condition. No uploader, hash or misfile link.

export const PORTAL_ADMIN_DOCUMENT_TYPES = ['id_proof', 'insurance'] as const satisfies readonly DocumentType[];

export interface PortalDocument {
  id: string;
  patientId: string;
  type: DocumentType;
  fileName: string;
  mime: Document['mime'];
  sizeBytes: number;
  createdAt: string;
  uploadedAt?: string;
}

export function toPortalDocument(d: Document): PortalDocument {
  return {
    id: d.id,
    patientId: d.patientId,
    type: d.type,
    fileName: d.fileName,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    createdAt: d.createdAt,
    ...(d.uploadedAt !== undefined && { uploadedAt: d.uploadedAt }),
  };
}

/** WHERE parts (on `documents d`) for the files the portal may show; `labelled` narrows to administrative types. */
function visibleDocuments(labelled: boolean): string[] {
  return [
    "d.status = 'ready'",
    'd.voided_at IS NULL',
    'NOT EXISTS (SELECT 1 FROM form_f f WHERE f.document_id = d.id)',
    'NOT EXISTS (SELECT 1 FROM mtp_register m WHERE m.document_id = d.id)',
    ...(labelled ? [`d.type IN (${PORTAL_ADMIN_DOCUMENT_TYPES.map((t) => `'${t}'`).join(', ')})`] : []),
  ];
}

/** #245: the patient's documents, newest first. */
export async function portalDocuments(
  db: Queryable,
  patientId: string,
  query: PageQuery & { type?: DocumentType },
): Promise<Page<PortalDocument>> {
  const params: unknown[] = [patientId];
  const where = ['d.patient_id = $1', ...visibleDocuments(await hasSensitiveLabel(db, patientId))];
  if (query.type) where.push(`d.type = $${params.push(query.type)}`);
  return pageRows(db, { select: 'SELECT d.* FROM documents d', where, params, orderBy: ['d.created_at', 'd.id'] }, query, (r) =>
    toPortalDocument(toDocument(r)),
  );
}

/**
 * The patient of a document the portal may show, or undefined (unknown, pending, misfiled, voided, or hidden by the
 * rules above). The caller still checks that the account may act for that patient.
 */
export async function portalDocumentPatient(db: Queryable, documentId: string): Promise<string | undefined> {
  const { rows } = await db.query(`SELECT d.patient_id FROM documents d WHERE d.id = $1 AND ${visibleDocuments(false).join(' AND ')}`, [documentId]);
  if (!rows[0]) return undefined;
  const patientId = String(rows[0].patient_id);
  if (await hasSensitiveLabel(db, patientId)) {
    const { rows: admin } = await db.query(`SELECT d.id FROM documents d WHERE d.id = $1 AND ${visibleDocuments(true).join(' AND ')}`, [documentId]);
    if (!admin[0]) return undefined;
  }
  return patientId;
}

/** Of `ids`, those the portal would show for this patient (same rules as #245). */
async function visibleDocumentIds(db: Queryable, patientId: string, ids: string[], labelled: boolean): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const { rows } = await db.query(
    `SELECT d.id FROM documents d WHERE d.patient_id = $1 AND d.id IN (${unique.map((_, i) => `$${i + 2}`).join(', ')})
       AND ${visibleDocuments(labelled).join(' AND ')}`,
    [patientId, ...unique],
  );
  return new Set(rows.map((r) => String(r.id)));
}

// #250: surgeries as the patient sees them: where, who, when, instructions, the estimate and the consent files.
// Never the team, checklist, op note, staff fields or anything paid to a partner venue. Cancelled and voided ones
// are left out. Consent ids are only those #246 would open (a labelled patient's consents are hidden, see above).

export interface PortalSurgeryItem extends PortalSurgery {
  consentDocumentIds: string[];
}

/** #250: newest first. */
export async function portalSurgeries(db: Queryable, patientId: string): Promise<PortalSurgeryItem[]> {
  const { rows } = await db.query(
    `SELECT s.*, u.name AS surgeon_name, h.name AS hospital_name FROM surgeries s
     LEFT JOIN users u ON u.id = s.surgeon_id LEFT JOIN partner_hospitals h ON h.id = s.partner_hospital_id
     WHERE s.patient_id = $1 AND s.status <> 'cancelled' AND s.voided_at IS NULL ORDER BY s.scheduled_at DESC, s.id DESC`,
    [patientId],
  );
  if (rows.length === 0) return [];
  const ownName = (await getHospital(db)).name;
  const surgeries = rows.map((r) => ({ row: r as Record<string, unknown>, s: toSurgery(r as Record<string, unknown>) }));
  const visible = await visibleDocumentIds(db, patientId, surgeries.flatMap(({ s }) => s.consentDocumentIds), await hasSensitiveLabel(db, patientId));
  return surgeries.map(({ row, s }) => {
    const hospitalName = s.venue === 'own' ? ownName || undefined : opt(row.hospital_name);
    return {
      id: s.id, status: s.status, patientId: s.patientId, procedure: s.procedure,
      ...(s.site !== undefined && { site: s.site }), ...(s.side !== undefined && { side: s.side }),
      scheduledAt: s.scheduledAt, venue: s.venue, ...(hospitalName && { hospitalName }),
      surgeonId: s.surgeonId, ...(opt(row.surgeon_name) && { surgeonName: String(row.surgeon_name) }),
      chargesPaise: s.chargesPaise, ...(s.instructions !== undefined && { instructions: s.instructions }),
      consentDocumentIds: s.consentDocumentIds.filter((id) => visible.has(id)),
    };
  });
}

// #247-#249: bills. Only bills the hospital has issued: final, part paid or paid. A draft is not a bill yet and a
// voided bill is gone (its credit note is the staff's record); both, and anything voided, are never shown. Money is
// as the staff bill has it (toBill), integer paise. No staff fields: version, created/updated by, the price-list id,
// the stock issue or pharmacy bill a line came from, discount reasons or approvers, who took a payment.
// A patient with any sensitive label gets every line's text replaced by its category ("Hospital services",
// "Medicines", "Medical supplies"): a test, procedure or drug name could reveal the labelled condition. Qty, rate and
// amounts stay, so the bill still adds up to what the patient owes.

export const PORTAL_BILL_STATUSES = ['final', 'part_paid', 'paid'] as const satisfies readonly BillStatus[];
export type PortalBillStatus = (typeof PORTAL_BILL_STATUSES)[number];

export const BILL_LINE_CATEGORIES = ['service', 'medicine', 'supply'] as const;
export type BillLineCategory = (typeof BILL_LINE_CATEGORIES)[number];

/** Category names used in place of a labelled patient's line text. */
export const BILL_CATEGORY_TEXT: Record<PrintLanguage, Record<BillLineCategory, string>> = {
  en: { service: 'Hospital services', medicine: 'Medicines', supply: 'Medical supplies' },
  hi: { service: 'अस्पताल सेवाएँ', medicine: 'दवाइयाँ', supply: 'चिकित्सा सामग्री' },
};

const lineCategory = (l: BillLine): BillLineCategory =>
  l.source?.kind === 'pharmacy_bill' ? 'medicine' : l.source?.kind === 'stock_issue' ? 'supply' : 'service';

export interface PortalBillLine {
  category: BillLineCategory;
  text: string;
  qty: number;
  unitPaise: number;
  discountPaise: number;
  gstRate: number;
  amountPaise: number;
}

export interface PortalBill {
  id: string;
  status: PortalBillStatus;
  patientId: string;
  encounterId?: string;
  admissionId?: string;
  series: BillSeries;
  number?: string;
  lines: PortalBillLine[];
  subtotalPaise: number;
  gstPaise: number;
  discountPaise: number;
  totalPaise: number;
  paidPaise: number;
  duePaise: number;
  createdAt: string;
  finalisedAt?: string;
}

export interface PortalPayment {
  id: string;
  mode: PaymentMode;
  amountPaise: number;
  at: string;
  /** The UPI or card reference. */
  reference?: string;
  /** The deposit receipt, when the payment was made from an advance deposit. */
  receiptNo?: string;
}

export interface PortalBillDetail extends PortalBill {
  payments: PortalPayment[];
}

export function toPortalBill(b: Bill, labelled: boolean): PortalBill {
  return {
    id: b.id,
    status: b.status as PortalBillStatus,
    patientId: b.patientId,
    ...(b.encounterId !== undefined && { encounterId: b.encounterId }),
    ...(b.admissionId !== undefined && { admissionId: b.admissionId }),
    series: b.series,
    ...(b.number !== undefined && { number: b.number }),
    lines: b.lines.map((l) => {
      const category = lineCategory(l);
      return {
        category,
        text: labelled ? BILL_CATEGORY_TEXT.en[category] : l.text,
        qty: l.qty,
        unitPaise: l.unitPaise,
        discountPaise: l.discountPaise,
        gstRate: l.gstRate,
        amountPaise: l.amountPaise,
      };
    }),
    subtotalPaise: b.subtotalPaise,
    gstPaise: b.gstPaise,
    discountPaise: b.discountPaise,
    totalPaise: b.totalPaise,
    paidPaise: b.paidPaise,
    duePaise: b.duePaise,
    createdAt: b.createdAt,
    ...(b.finalisedAt !== undefined && { finalisedAt: b.finalisedAt }),
  };
}

const VISIBLE_BILL = `status IN (${PORTAL_BILL_STATUSES.map((s) => `'${s}'`).join(', ')}) AND voided_at IS NULL`;

/** #247: the patient's issued bills, newest first. */
export async function portalBills(db: Queryable, patientId: string, query: PageQuery & { status?: PortalBillStatus }): Promise<Page<PortalBill>> {
  const labelled = await hasSensitiveLabel(db, patientId);
  const params: unknown[] = [patientId];
  const where = ['patient_id = $1', VISIBLE_BILL];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  return pageRows(db, { select: 'SELECT * FROM bills', where, params, orderBy: ['created_at', 'id'] }, query, (r) => toPortalBill(toBill(r), labelled));
}

/** The patient of a bill the portal may show, or undefined (unknown, draft, voided). The caller checks the account. */
export async function portalBillPatient(db: Queryable, billId: string): Promise<string | undefined> {
  const { rows } = await db.query(`SELECT patient_id FROM bills WHERE id = $1 AND ${VISIBLE_BILL}`, [billId]);
  return rows[0] ? String(rows[0].patient_id) : undefined;
}

/** A bill the portal may show, read again after the access check; the generic 403 if it has just been voided. */
async function visibleBill(db: Queryable, billId: string): Promise<Bill> {
  const bill = await getBill(db, billId);
  if (!(PORTAL_BILL_STATUSES as readonly string[]).includes(bill.status)) throw new AppError(403, 'forbidden', 'not a patient this account may see');
  return bill;
}

/** #248: one bill with its payments. The caller has resolved the bill's patient through portalBillPatient. */
export async function portalBillDetail(db: Queryable, billId: string): Promise<PortalBillDetail> {
  const bill = await visibleBill(db, billId);
  const { rows } = await db.query(
    `SELECT p.id, p.amount_paise, p.mode, p.reference, p.created_at, d.receipt_no FROM payments p
     LEFT JOIN deposits d ON d.id = p.deposit_id WHERE p.bill_id = $1 AND p.voided_at IS NULL ORDER BY p.created_at, p.id`,
    [billId],
  );
  return {
    ...toPortalBill(bill, await hasSensitiveLabel(db, bill.patientId)),
    payments: rows.map((r) => ({
      id: String(r.id),
      mode: r.mode as PaymentMode,
      amountPaise: Number(r.amount_paise),
      at: (r.created_at as Date).toISOString(),
      ...(r.reference != null && { reference: String(r.reference) }),
      ...(r.receipt_no != null && { receiptNo: String(r.receipt_no) }),
    })),
  };
}

/** #249: the staff print (#125) of the bill; a labelled patient's lines are printed as their categories. */
export async function portalBillHtml(db: Queryable, billId: string, lang: PrintLanguage): Promise<string> {
  const bill = await visibleBill(db, billId);
  // Without the tariff id the renderer can't look up a Hindi test name either.
  const masked = (l: BillLine): BillLine => ({
    text: BILL_CATEGORY_TEXT[lang][lineCategory(l)],
    qty: l.qty,
    unitPaise: l.unitPaise,
    discountPaise: l.discountPaise,
    gstRate: l.gstRate,
    amountPaise: l.amountPaise,
  });
  const printed: Bill = (await hasSensitiveLabel(db, bill.patientId)) ? { ...bill, lines: bill.lines.map(masked) } : bill;
  return billHtml(db, printed, await billPayments(db, billId), lang);
}

/** #244: the patient's prescriptions that were issued (confirmed or dispensed), newest first. */
export async function portalPrescriptions(db: Queryable, patientId: string, query: PageQuery): Promise<Page<PortalPrescription>> {
  return pageRows(
    db,
    {
      select: 'SELECT * FROM prescriptions',
      where: ['patient_id = $1', "status IN ('confirmed', 'dispensed')", 'voided_at IS NULL'],
      params: [patientId],
      orderBy: ['created_at', 'id'],
    },
    query,
    (r) => toPortalPrescription(toPrescription(r)),
  );
}
