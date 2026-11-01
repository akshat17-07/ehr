import { HOSPITAL_ID } from '../modules/reference/hospital.js';
import type { Queryable } from './migrate.js';
import { seedId, seedInsert } from './table.js';

// Sample data for the local database only (npm run seed): one user per staff type, departments and common drugs.
// The drug list is for trying the app, not a verified formulary: schedules and GST must be checked before real use.
// Fixed ids + ON CONFLICT DO NOTHING, so running it again changes nothing.

/** Log in locally with header `x-dev-user: <sub>|<email>|<type>`, e.g. `dev-doctor|doctor@dev.local|doctor`. */
export const DEV_USERS = [
  { sub: 'dev-admin', name: 'Asha Verma', type: 'admin', departments: [] },
  { sub: 'dev-head-doctor', name: 'Dr Rakesh Sharma', type: 'head_doctor', departments: ['MED'] },
  { sub: 'dev-doctor', name: 'Dr Neha Gupta', type: 'doctor', departments: ['MED'], council: true },
  { sub: 'dev-surgeon', name: 'Dr Vikram Singh', type: 'doctor', departments: ['SUR', 'ORT'], council: true },
  { sub: 'dev-nurse', name: 'Sunita Yadav', type: 'nurse', departments: ['MED'] },
  { sub: 'dev-reception', name: 'Pooja Patel', type: 'staff', departments: [], bundles: ['reception'] },
  { sub: 'dev-billing', name: 'Amit Jain', type: 'staff', departments: [], bundles: ['billing'] },
  { sub: 'dev-medical', name: 'Rahul Tiwari', type: 'medical', departments: [], pharmacist: true },
  { sub: 'dev-insurance', name: 'Kiran Mehta', type: 'insurance', departments: [] },
  { sub: 'dev-gp', name: 'Dr Anil Dubey', type: 'gp', departments: [] },
] as const;

export const DEV_DEPARTMENTS = [
  ['MED', 'General Medicine', 'सामान्य चिकित्सा'],
  ['SUR', 'General Surgery', 'सामान्य शल्य चिकित्सा'],
  ['ORT', 'Orthopaedics', 'हड्डी रोग'],
  ['DEN', 'Dental', 'दंत चिकित्सा'],
  ['OBG', 'Obstetrics and Gynaecology', 'प्रसूति एवं स्त्री रोग'],
  ['PED', 'Paediatrics', 'शिशु रोग'],
  ['RAD', 'Radiology', 'रेडियोलॉजी'],
  ['LAB', 'Pathology', 'पैथोलॉजी'],
  ['EMR', 'Emergency', 'आपातकालीन'],
] as const;

// [name, strength, form, schedule, mrpPaise]. HSN 3004, GST 5% (most medicines since September 2025; verify).
export const DEV_DRUGS = [
  ['Paracetamol', '500 mg', 'tablet', 'OTC', 2000],
  ['ORS', '21.8 g', 'powder', 'OTC', 2200],
  ['Amoxicillin', '500 mg', 'capsule', 'H', 9500],
  ['Metformin', '500 mg', 'tablet', 'H', 3500],
  ['Amlodipine', '5 mg', 'tablet', 'H', 4000],
  ['Pantoprazole', '40 mg', 'tablet', 'H', 9000],
  ['Ondansetron', '4 mg', 'injection', 'H', 1500],
  ['Cefixime', '200 mg', 'tablet', 'H1', 11000],
  ['Ceftriaxone', '1 g', 'injection', 'H1', 6500],
  ['Tramadol', '50 mg', 'capsule', 'H1', 6000],
  ['Alprazolam', '0.25 mg', 'tablet', 'H1', 3000],
  ['Morphine', '10 mg/ml', 'injection', 'NDPS', 3500],
] as const;

/** code, English name, Hindi name, department code, price in rupees, setting. Services in a hospital are GST-exempt (SAC 9993). */
export const DEV_TARIFFS = [
  ['OPD-GEN', 'OPD consultation', 'ओपीडी परामर्श', 'MED', 300, 'opd'],
  ['OPD-SPL', 'Specialist consultation', 'विशेषज्ञ परामर्श', 'SUR', 500, 'opd'],
  ['ER-REG', 'Emergency registration', 'आपातकालीन पंजीकरण', 'EMR', 200, 'both'],
  ['LAB-CBC', 'Complete blood count', 'संपूर्ण रक्त गणना', 'LAB', 350, 'both'],
  ['LAB-RBS', 'Random blood sugar', 'रैंडम ब्लड शुगर', 'LAB', 100, 'both'],
  ['RAD-XRC', 'X-ray chest PA view', 'छाती का एक्स-रे', 'RAD', 450, 'both'],
  ['RAD-USG', 'Ultrasound abdomen', 'पेट का अल्ट्रासाउंड', 'RAD', 1200, 'both'],
  ['IPD-GEN', 'General ward bed (per day)', 'सामान्य वार्ड बिस्तर (प्रति दिन)', null, 1500, 'ipd'],
  ['IPD-PVT', 'Private room (per day)', 'निजी कमरा (प्रति दिन)', null, 3500, 'ipd'],
  ['IPD-NUR', 'Nursing charges (per day)', 'नर्सिंग शुल्क (प्रति दिन)', null, 500, 'ipd'],
] as const;

/** drug name, batch no, expiry, cost and MRP in rupees, on hand, quarantined, recalled. */
const DEV_BATCHES = [
  ['Paracetamol', 'PCM2401', '2025-12-31', 12, 20, 40, 0, false],
  ['Paracetamol', 'PCM2502', '2030-06-30', 13, 20, 300, 20, false],
  ['Paracetamol', 'PCM2503', '2031-01-31', 13, 21, 500, 0, false],
  ['Amoxicillin', 'AMX2501', '2030-03-31', 60, 95, 120, 0, false],
  ['Amoxicillin', 'AMX2499', '2029-12-31', 58, 95, 60, 60, true],
] as const;

const DEV_PARTNER_HOSPITALS = ['AIIMS Bhopal', 'Hamidia Hospital, Bhopal', 'Bansal Hospital, Bhopal'];

const DEV_INSURERS = [['Star Health and Allied Insurance', 'STAR'], ['ICICI Lombard General Insurance', 'ICICI'], ['The New India Assurance', 'NIA'], ['Care Health Insurance', 'CARE']] as const;

const DEV_TPAS = [['Medi Assist', 'MEDI'], ['MD India Health Insurance TPA', 'MDI'], ['Paramount Health Services', 'PHS'], ['Vidal Health TPA', 'VIDAL']] as const;

/** A few common ICD-10 codes, until the WHO table is loaded. */
const DEV_ICD10 = [
  ['A09', 'Infectious gastroenteritis and colitis, unspecified'],
  ['A90', 'Dengue fever [classical dengue]'],
  ['B54', 'Unspecified malaria'],
  ['E11.9', 'Type 2 diabetes mellitus without complications'],
  ['I10', 'Essential (primary) hypertension'],
  ['J06.9', 'Acute upper respiratory infection, unspecified'],
  ['J18.9', 'Pneumonia, unspecified'],
  ['K35.8', 'Acute appendicitis, other and unspecified'],
  ['O80', 'Single spontaneous delivery'],
  ['S72.0', 'Fracture of neck of femur'],
] as const;

/** uhid, name, sex, dob or age, mobile, days since last visit (null: never). Two share a mobile, as families do. */
export const DEV_PATIENTS = [
  ['U24000001', 'Ramesh Kumar Sharma', 'M', '1968-05-14', '9826000001', 2],
  ['U24000002', 'Sita Sharma', 'F', '1972-11-02', '9826000001', 40],
  ['U25000003', 'Mohd. Irfan Khan', 'M', 45, '9893000003', 1],
  ['U25000004', 'Kavita Patel', 'F', '1995-01-20', '7000000004', null],
  ['U26000005', 'Rahul Verma', 'M', '2016-08-09', '8800000005', 5],
] as const;

const DEV_HOSPITAL_ADDRESS = { line1: '12 Hoshangabad Road', city: 'Bhopal', district: 'Bhopal', state: 'Madhya Pradesh', pincode: '462011' };

export function devSeedStatements(): string[] {
  const departmentId = (code: string) => seedId('de000000', DEV_DEPARTMENTS.findIndex(([c]) => c === code) + 1);
  return [
    ...DEV_DEPARTMENTS.map(([code, nameEn, nameHi], i) =>
      seedInsert('departments', seedId('de000000', i + 1), { code, name_en: nameEn, name_hi: nameHi, active: true }),
    ),
    ...DEV_DRUGS.map(([name, strength, form, schedule, mrp], i) =>
      seedInsert('drugs', seedId('d0000000', i + 1), {
        name, strength, form, schedule, hsn: '3004', gst_rate: '5', mrp_paise: String(mrp), active: true,
      }),
    ),
    // The blank hospital row from migration 0016, filled in (only while still blank).
    `UPDATE hospital SET name = 'Shanti Multispeciality Hospital', phone = '07554000000', email = 'desk@shanti.dev.local',
       address = '${JSON.stringify(DEV_HOSPITAL_ADDRESS)}', mp_licence_no = 'MP/BPL/2024/0101', licence_valid_till = '2029-03-31',
       gstin = '23AAAAA0000A1Z5', pcpndt_reg_no = 'PCPNDT/BPL/0042', mtp_reg_no = 'MTP/BPL/0017'
     WHERE id = '${HOSPITAL_ID}' AND name = ''`,
    ...DEV_TARIFFS.map(([code, nameEn, nameHi, dept, rupees, setting], i) =>
      seedInsert('tariffs', seedId('7a000000', i + 1), {
        list_version: '1', code, name_en: nameEn, name_hi: nameHi, ...(dept && { department_id: departmentId(dept) }),
        price_paise: String(rupees * 100), gst_rate: '0', sac_code: '999311', setting, valid_from: '2024-04-01',
      }),
    ),
    ...DEV_BATCHES.map(([drug, batchNo, expiry, cost, mrp, onHand, quarantined, recalled], i) =>
      seedInsert('batches', seedId('ba000000', i + 1), {
        item_id: seedId('d0000000', DEV_DRUGS.findIndex(([name]) => name === drug) + 1),
        batch_no: batchNo, expiry, cost_paise: String(cost * 100), mrp_paise: String(mrp * 100),
        qty_on_hand: String(onHand), qty_quarantined: String(quarantined), recalled,
      }),
    ),
    ...DEV_PARTNER_HOSPITALS.map((name, i) => seedInsert('partner_hospitals', seedId('9a000000', i + 1), { name })),
    ...DEV_INSURERS.map(([name, code], i) => seedInsert('insurers', seedId('1a000000', i + 1), { name, code, active: true })),
    ...DEV_TPAS.map(([name, code], i) => seedInsert('tpas', seedId('1b000000', i + 1), { name, code, active: true })),
    ...DEV_ICD10.map(([code, text], i) => seedInsert('codes', seedId('c0de1000', i + 1), { system: 'icd10', code, text })),
    ...DEV_PATIENTS.map(([uhid, name, sex, born, mobile, daysAgo], i) =>
      seedInsert('patients', seedId('9a710000', i + 1), {
        uhid, name, name_search: name.toLowerCase(), sex, mobile, labels: '[]', allergies: i === 0 ? '["Penicillin"]' : '[]',
        ...(typeof born === 'string' ? { dob: born } : { age_years: String(born), age_recorded_on: '2025-06-01' }),
        ...(daysAgo !== null && { last_activity_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }),
      }),
    ),
    ...DEV_USERS.flatMap((u, i) => {
      const user = seedInsert('users', seedId('a0000000', i + 1), {
        cognito_sub: u.sub,
        name: u.name,
        email: `${u.sub.replace(/^dev-/, '')}@dev.local`,
        mobile: `98000000${String(i).padStart(2, '0')}`,
        type: u.type,
        department_ids: JSON.stringify(u.departments.map(departmentId)),
        ...('council' in u && { council_name: 'Madhya Pradesh Medical Council', council_reg_no: `MP-${1000 + i}`, reg_valid_till: '2030-12-31' }),
        ...('pharmacist' in u && { pharmacist_reg_no: `MPPC-${2000 + i}` }),
        active: true,
      });
      if (!('bundles' in u)) return [user];
      return [
        user,
        seedInsert('user_permissions', seedId('a1000000', i + 1), { user_id: u.sub, allow: '[]', deny: '[]', bundles: JSON.stringify(u.bundles) }),
      ];
    }),
  ];
}

/** Adds the sample data to a local database. */
export async function seedDev(db: Queryable): Promise<number> {
  const statements = devSeedStatements();
  for (const sql of statements) await db.query(sql);
  return statements.length;
}
