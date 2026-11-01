import type { Queryable } from '../../db/migrate.js';
import { seedId, seedInsert } from '../../db/table.js';

// The hospital's own details (api-list.md Hospital): one row, made by the migration with blanks for the Admin to fill
// in with PATCH /admin/hospital (#189). address is JSON text (api-list.md Address).

export const HOSPITAL_ID = seedId('4e000000', 1);

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
}

export interface Hospital {
  id: string;
  version: number;
  name: string;
  address: Address;
  phone: string;
  email: string;
  mpLicenceNo: string;
  /** YYYY-MM-DD; missing until the Admin sets it. */
  licenceValidTill?: string;
  gstin?: string;
  pcpndtRegNo?: string;
  mtpRegNo?: string;
  invoicePrefix: string;
  billOfSupplyPrefix: string;
}

const BLANK_ADDRESS: Address = { line1: '', city: '', district: '', state: 'Madhya Pradesh', pincode: '' };

/** The INSERT for the one row (blank until the Admin fills it in). */
export function seedHospital(): string {
  return seedInsert('hospital', HOSPITAL_ID, {
    name: '',
    address: JSON.stringify(BLANK_ADDRESS),
    phone: '',
    email: '',
    mp_licence_no: '',
    invoice_prefix: 'INV',
    bill_of_supply_prefix: 'BOS',
  });
}

const opt = (v: unknown) => (v == null ? undefined : String(v));

function toHospital(r: Record<string, unknown>): Hospital {
  const hospital: Hospital = {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    address: JSON.parse(String(r.address)) as Address,
    phone: String(r.phone),
    email: String(r.email),
    mpLicenceNo: String(r.mp_licence_no),
    licenceValidTill: opt(r.licence_valid_till_text),
    gstin: opt(r.gstin),
    pcpndtRegNo: opt(r.pcpndt_reg_no),
    mtpRegNo: opt(r.mtp_reg_no),
    invoicePrefix: String(r.invoice_prefix),
    billOfSupplyPrefix: String(r.bill_of_supply_prefix),
  };
  for (const key of Object.keys(hospital) as (keyof Hospital)[]) if (hospital[key] === undefined) delete hospital[key];
  return hospital;
}

/** #8: the hospital's details. */
export async function getHospital(db: Queryable): Promise<Hospital> {
  // The date as text, so no time zone can move it a day.
  const { rows } = await db.query('SELECT hospital.*, licence_valid_till::text AS licence_valid_till_text FROM hospital WHERE id = $1', [
    HOSPITAL_ID,
  ]);
  if (!rows[0]) throw new Error('The hospital row is missing (migration 0016 adds it)');
  return toHospital(rows[0]);
}
