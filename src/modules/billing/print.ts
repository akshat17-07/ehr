import type { Queryable } from '../../db/migrate.js';
import { getHospital } from '../reference/hospital.js';
import { getPatient } from '../patients/patients.js';
import type { Payment } from './payments.js';
import type { Bill } from './bills.js';

export const PRINT_LANGUAGES = ['en', 'hi'] as const;
export type PrintLanguage = (typeof PRINT_LANGUAGES)[number];

const LABELS = {
  en: {
    tax_invoice: 'Tax Invoice',
    bill_of_supply: 'Bill of Supply',
    draft: 'DRAFT: not a bill',
    void: 'VOID',
    creditNote: 'Credit note',
    number: 'Bill no.',
    date: 'Date',
    patient: 'Patient',
    uhid: 'UHID',
    item: 'Item',
    qty: 'Qty',
    rate: 'Rate',
    discount: 'Discount',
    gst: 'GST %',
    amount: 'Amount',
    subtotal: 'Subtotal',
    gstIncluded: 'GST included',
    total: 'Total',
    paid: 'Paid',
    due: 'Due',
    payments: 'Payments',
    gstin: 'GSTIN',
    phone: 'Phone',
  },
  hi: {
    tax_invoice: 'कर बीजक',
    bill_of_supply: 'आपूर्ति का बिल',
    draft: 'ड्राफ्ट: यह बिल नहीं है',
    void: 'रद्द',
    creditNote: 'क्रेडिट नोट',
    number: 'बिल नं.',
    date: 'दिनांक',
    patient: 'मरीज़',
    uhid: 'UHID',
    item: 'विवरण',
    qty: 'मात्रा',
    rate: 'दर',
    discount: 'छूट',
    gst: 'GST %',
    amount: 'राशि',
    subtotal: 'उप-योग',
    gstIncluded: 'GST शामिल',
    total: 'कुल',
    paid: 'भुगतान',
    due: 'बकाया',
    payments: 'भुगतान विवरण',
    gstin: 'GSTIN',
    phone: 'फ़ोन',
  },
} as const;

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const rupees = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Hindi names of the bill's tariff lines; lines without one keep their own text. */
async function hindiNames(db: Queryable, bill: Bill): Promise<Map<string, string>> {
  const ids = [...new Set(bill.lines.flatMap((l) => (l.tariffId ? [l.tariffId] : [])))];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(`SELECT id::text AS id, name_hi FROM tariffs WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  return new Map(rows.filter((r) => r.name_hi != null).map((r) => [String(r.id), String(r.name_hi)]));
}

/**
 * #125: the bill as one printable HTML page (A4, no scripts), in English or Hindi.
 * A draft is marked as not a bill; a void bill shows its credit note.
 */
export async function billHtml(db: Queryable, bill: Bill, payments: Payment[], lang: PrintLanguage): Promise<string> {
  const t = LABELS[lang];
  const hospital = await getHospital(db);
  const patient = await getPatient(db, bill.patientId);
  const names = lang === 'hi' ? await hindiNames(db, bill) : new Map<string, string>();
  const a = hospital.address;
  const address = [a.line1, a.line2, a.city, a.district, a.state, a.pincode].filter(Boolean).join(', ');
  const stamp = bill.status === 'draft' ? t.draft : bill.status === 'void' ? t.void : '';
  const rows = bill.lines
    .map(
      (l) =>
        `<tr><td>${escape((l.tariffId && names.get(l.tariffId)) || l.text)}</td><td class="n">${l.qty}</td><td class="n">${rupees(l.unitPaise)}</td>` +
        `<td class="n">${l.discountPaise ? rupees(l.discountPaise) : ''}</td><td class="n">${l.gstRate}</td><td class="n">${rupees(l.amountPaise)}</td></tr>`,
    )
    .join('');
  const sum = (label: string, paise: number) => `<tr><th colspan="5">${label}</th><td class="n">${rupees(paise)}</td></tr>`;
  const paid = payments.map((p) => `<li>${day(p.at)}: ${rupees(p.amountPaise)} (${escape(p.mode)}${p.reference ? ' ' + escape(p.reference) : ''})</li>`).join('');
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${escape(bill.number ?? t[bill.series])}</title>
<style>@page{size:A4;margin:12mm}body{font:12px sans-serif;color:#000}h1,h2{margin:0}h2{font-size:15px;margin:8px 0}
table{width:100%;border-collapse:collapse;margin-top:8px}td,th{border:1px solid #888;padding:3px 5px;text-align:left}.n{text-align:right}
.stamp{font-size:18px;font-weight:bold;border:2px solid #000;display:inline-block;padding:2px 8px}</style></head><body>
<h1>${escape(hospital.name)}</h1>
<div>${escape(address)}</div>
<div>${t.phone}: ${escape(hospital.phone)}${bill.series === 'tax_invoice' && hospital.gstin ? ` · ${t.gstin}: ${escape(hospital.gstin)}` : ''}</div>
<h2>${t[bill.series]}</h2>
${stamp ? `<div class="stamp">${stamp}</div>` : ''}
<div>${t.number}: ${escape(bill.number ?? '-')} · ${t.date}: ${day(bill.finalisedAt ?? bill.createdAt)}${bill.creditNoteNo ? ` · ${t.creditNote}: ${escape(bill.creditNoteNo)}` : ''}</div>
<div>${t.patient}: ${escape(patient.name)} · ${t.uhid}: ${escape(patient.uhid)}</div>
<table><thead><tr><th>${t.item}</th><th class="n">${t.qty}</th><th class="n">${t.rate}</th><th class="n">${t.discount}</th><th class="n">${t.gst}</th><th class="n">${t.amount}</th></tr></thead>
<tbody>${rows}</tbody><tfoot>
${sum(t.subtotal, bill.subtotalPaise)}${bill.discountPaise ? sum(t.discount, bill.discountPaise) : ''}${bill.gstPaise ? sum(t.gstIncluded, bill.gstPaise) : ''}
${sum(t.total, bill.totalPaise)}${sum(t.paid, bill.paidPaise)}${sum(t.due, bill.duePaise)}
</tfoot></table>
${paid ? `<h2>${t.payments}</h2><ul>${paid}</ul>` : ''}
</body></html>`;
}
