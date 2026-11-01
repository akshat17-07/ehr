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
