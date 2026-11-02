import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { listAllergies } from '../patients/allergies.js';

// Prescribing checks (api-list.md RxAlert), run on every typed or confirmed prescription and by #65.
// - allergy: the drug is the allergy's linked drug, or its name matches the substance or the substance's drug group.
//   A severe allergy blocks; others warn.
// - duplicate: the same drug twice in one prescription (warns).
// - dose: a course over 90 days (warns).
// - schedule: H1 / X / NDPS drugs need a register entry at the pharmacy (info).
// - interaction: not checked yet; it needs a licensed interaction list.
// A warning must be acknowledged (its id sent back in acknowledgedAlerts); a block cannot be.

export interface RxLine {
  drugId?: string;
  drugText: string;
  strength?: string;
  form?: string;
  dose: string;
  frequency: string;
  route?: string;
  days: number;
  quantity?: number;
  instructions?: string;
}

export const RX_ALERT_SEVERITIES = ['info', 'warning', 'block'] as const;
export const RX_ALERT_KINDS = ['allergy', 'duplicate', 'interaction', 'dose', 'schedule'] as const;

export interface RxAlert {
  /** `kind:lineIndex`, what acknowledgedAlerts lists. */
  id: string;
  severity: (typeof RX_ALERT_SEVERITIES)[number];
  kind: (typeof RX_ALERT_KINDS)[number];
  message: string;
  lineIndex: number;
}

/** Allergy words that stand for a group of drugs (lower case); the drug name is matched against the members. */
const DRUG_GROUPS: Record<string, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'cloxacillin', 'piperacillin'],
  cephalosporin: ['cefixime', 'ceftriaxone', 'cefuroxime', 'cefalexin', 'cephalexin', 'cefpodoxime', 'cefotaxime'],
  sulfa: ['sulfamethoxazole', 'cotrimoxazole', 'sulfasalazine', 'sulfadiazine'],
  nsaid: ['ibuprofen', 'diclofenac', 'aspirin', 'naproxen', 'aceclofenac', 'ketorolac', 'mefenamic'],
};

const MAX_DAYS = 90;

function matchesAllergy(drugName: string, substance: string): boolean {
  const name = drugName.toLowerCase();
  const s = substance.toLowerCase();
  if (name.includes(s) || s.includes(name)) return true;
  return Object.entries(DRUG_GROUPS).some(([group, members]) => s.includes(group) && members.some((m) => name.includes(m)));
}

/** The alerts for these lines; 422 if a drugId is not an active drug in the list. */
export async function checkLines(db: Queryable, patientId: string, lines: RxLine[]): Promise<RxAlert[]> {
  const drugs = new Map<string, { name: string; schedule: string }>();
  for (const id of new Set(lines.flatMap((l) => (l.drugId ? [l.drugId] : [])))) {
    const { rows } = await db.query('SELECT name, schedule FROM drugs WHERE id = $1 AND active', [id]);
    if (!rows[0]) throw new AppError(422, 'invalid_input', `drugId ${id}: not in the drug list`);
    drugs.set(id, { name: String(rows[0].name), schedule: String(rows[0].schedule) });
  }
  const allergies = await listAllergies(db, patientId);

  const alerts: RxAlert[] = [];
  const add = (lineIndex: number, kind: RxAlert['kind'], severity: RxAlert['severity'], message: string) => {
    if (!alerts.some((a) => a.id === `${kind}:${lineIndex}`)) alerts.push({ id: `${kind}:${lineIndex}`, severity, kind, message, lineIndex });
  };
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const drug = line.drugId ? drugs.get(line.drugId) : undefined;
    const names = [line.drugText, ...(drug ? [drug.name] : [])];
    for (const a of allergies) {
      if ((a.drugId && a.drugId === line.drugId) || names.some((n) => matchesAllergy(n, a.substance))) {
        add(i, 'allergy', a.severity === 'severe' ? 'block' : 'warning', `Allergy: ${a.substance}${a.reaction ? ` (${a.reaction})` : ''}, ${a.severity}`);
      }
    }
    const key = line.drugId ?? line.drugText.trim().toLowerCase();
    if (seen.has(key)) add(i, 'duplicate', 'warning', `${line.drugText} is already on this prescription`);
    seen.add(key);
    if (line.days > MAX_DAYS) add(i, 'dose', 'warning', `A course of ${line.days} days (over ${MAX_DAYS})`);
    if (drug && ['H1', 'X', 'NDPS'].includes(drug.schedule)) {
      add(i, 'schedule', 'info', `Schedule ${drug.schedule}: the pharmacy enters it in the ${drug.schedule} register`);
    }
  });
  return alerts;
}

/** 409 rx_alerts (with all the alerts) on a block, or on a warning not in `acknowledged`. */
export function assertAlertsCleared(alerts: RxAlert[], acknowledged: string[]): void {
  const open = alerts.filter((a) => a.severity === 'block' || (a.severity === 'warning' && !acknowledged.includes(a.id)));
  if (open.length > 0) {
    const blocked = open.some((a) => a.severity === 'block');
    throw new AppError(409, 'rx_alerts', blocked ? 'a blocking alert: change the prescription' : 'acknowledge the warnings first', { alerts });
  }
}
