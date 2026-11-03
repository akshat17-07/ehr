import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { UUID } from '../users/users.js';
import { getPatient, type BaseFields } from './patients.js';

// Merging duplicate patients (api-list.md PatientMerge): one person proposes (#28), a second approves (#181) or
// rejects (#182). Only on approval do records move to the kept UHID; until then nothing changes.
// status: pending / approved / rejected.

export interface PatientMerge extends BaseFields {
  keepPatientId: string;
  mergePatientId: string;
  reason: string;
  proposedBy: string;
  approvedBy?: string;
  /** How many rows moved to the kept UHID, per table (tables where none moved are left out). Set on approval. */
  movedCounts?: Record<string, number>;
}

export interface NewMerge {
  keepPatientId: string;
  mergePatientId: string;
  reason: string;
}

export function toMerge(r: Record<string, unknown>): PatientMerge {
  return {
    ...baseFields(r as unknown as BaseRow),
    keepPatientId: String(r.keep_patient_id),
    mergePatientId: String(r.merge_patient_id),
    reason: String(r.reason),
    proposedBy: String(r.proposed_by),
    ...(r.approved_by != null && { approvedBy: String(r.approved_by) }),
    ...(r.moved_rows != null && {
      movedCounts: Object.fromEntries(Object.entries(JSON.parse(String(r.moved_rows)) as Record<string, string[]>).map(([table, ids]) => [table, ids.length])),
    }),
  };
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);

/** #28: proposes merging `mergePatientId` into `keepPatientId`. 409 if either is merged or already in a pending merge. */
export async function proposeMerge(db: Queryable, input: NewMerge, by: string): Promise<PatientMerge> {
  if (input.keepPatientId === input.mergePatientId) throw invalid('choose two different patients');
  for (const [field, id] of [['keepPatientId', input.keepPatientId], ['mergePatientId', input.mergePatientId]] as const) {
    await getPatient(db, id).catch(() => {
      throw invalid(`${field}: no such patient`);
    });
  }
  const ids = [input.keepPatientId, input.mergePatientId];
  const merged = await db.query('SELECT uhid FROM patients WHERE id IN ($1, $2) AND merged_into IS NOT NULL', ids);
  if (merged.rows[0]) throw new AppError(409, 'merged', `${String(merged.rows[0].uhid)} is already merged into another patient`);
  const pending = await db.query(
    `SELECT 1 FROM patient_merges WHERE status = 'pending'
       AND (keep_patient_id IN ($1, $2) OR merge_patient_id IN ($1, $2))`,
    ids,
  );
  if (pending.rows[0]) throw new AppError(409, 'merge_pending', 'one of these patients is already in a merge waiting for approval');

  const { rows } = await db.query(
    `INSERT INTO patient_merges (id, status, created_by, updated_by, keep_patient_id, merge_patient_id, reason, proposed_by)
     VALUES ($1, 'pending', $2, $2, $3, $4, $5, $2) RETURNING *`,
    [randomUUID(), by, input.keepPatientId, input.mergePatientId, input.reason],
  );
  return toMerge(rows[0] as Record<string, unknown>);
}

/**
 * Tables whose rows follow the person: on approval their patient_id moves to the kept patient (guardians also has
 * guardian_patient_id, moved too). The tables with a patient_id that stay put are in MERGE_STAYS;
 * test/admin-patient-merges.test.ts fails when a table with a patient_id column is in neither list.
 */
export const MERGE_MOVES = [
  'consents', 'guardians', 'appointments', 'encounters', 'vitals', 'observations', 'notes', 'diagnoses', 'allergies',
  'problems', 'orders', 'order_results', 'prescriptions', 'admissions', 'mar_entries', 'discharge_summaries',
  'dental_entries', 'anc_records', 'form_f', 'mtp_register', 'surgeries', 'implants', 'documents', 'dispenses',
  'pharmacy_returns', 'pharmacy_bills', 'indents', 'stock_issues', 'bills', 'payments', 'deposits', 'refunds',
  'policies', 'claims', 'agent_links', 'referrals', 'record_requests', 'share_links', 'rights_requests', 'legal_holds',
] as const;
/** Kept as they were written: the merge itself, access / break-glass history, the audit log and generated exports. */
export const MERGE_STAYS = ['patient_merges', 'access_requests', 'break_glass_events', 'audit_events', 'exports'] as const;

/**
 * #181 / #182: a second person decides a pending merge. 404 if there is none, 403 for whoever proposed it, 409 if it
 * is not pending. Approving moves the merged patient's records to the kept UHID (MERGE_MOVES), adds their sensitive
 * labels, allergies and latest activity to the kept patient (so no label is lost) and points the merged patient at
 * the kept one (merged_into). 409 if either patient was merged into someone else meanwhile. Rejecting changes nothing
 * else. The note / reason is kept in the merge's history. One transaction: all or nothing.
 */
export async function decideMerge(
  db: Queryable,
  id: string,
  decision: { approve: true; note?: string } | { approve: false; reason: string },
  by: string,
): Promise<PatientMerge> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM patient_merges WHERE id = $1', [id]) : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  if (row.proposed_by === by) throw new AppError(403, 'forbidden', "you can't decide a merge you proposed");
  if (row.status !== 'pending') throw new AppError(409, 'conflict', `this merge is already ${row.status}`);
  const change = { id, version: Number(row.version), by, reason: decision.approve ? decision.note : decision.reason };
  return withTransaction(db, async (tx) => {
    if (!decision.approve) return toMerge(await updateRecord(tx, 'patient_merges', { ...change, set: { status: 'rejected' } }));
    const keepId = String(row.keep_patient_id);
    const mergeId = String(row.merge_patient_id);
    const { rows: both } = await tx.query('SELECT * FROM patients WHERE id IN ($1, $2)', [keepId, mergeId]);
    const keep = both.find((p) => String(p.id) === keepId);
    const gone = both.find((p) => String(p.id) === mergeId);
    if (!keep || !gone) throw new AppError(409, 'conflict', 'one of these patients no longer exists');
    if (keep.merged_into != null || gone.merged_into != null) throw new AppError(409, 'merged', 'one of these patients was merged into another meanwhile');

    // The ids of every row moved are kept on the merge, so it can be audited and undone.
    const moved: Record<string, string[]> = {};
    const move = async (table: string, column: string) => {
      const { rows: changed } = await tx.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING id`, [keepId, mergeId]);
      if (changed.length > 0) moved[column === 'patient_id' ? table : `${table}.${column}`] = changed.map((r) => String(r.id));
    };
    for (const table of MERGE_MOVES) await move(table, 'patient_id');
    await move('guardians', 'guardian_patient_id');

    // Entries are strings; compared by their JSON so any other shape still folds duplicates (and ignoring case).
    const same = (e: unknown) => JSON.stringify(e).toLowerCase();
    const union = (a: unknown, b: unknown) => {
      const seen = new Set<string>();
      const all = [...(JSON.parse(String(a)) as unknown[]), ...(JSON.parse(String(b)) as unknown[])];
      return JSON.stringify(all.filter((e) => !seen.has(same(e)) && seen.add(same(e))));
    };
    const latest = [keep.last_activity_at, gone.last_activity_at].filter((d): d is Date => d instanceof Date).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
    await updateRecord(tx, 'patients', {
      id: keepId,
      version: Number(keep.version),
      by,
      reason: `merged ${String(gone.uhid)} into this record`,
      set: { labels: union(keep.labels, gone.labels), allergies: union(keep.allergies, gone.allergies), last_activity_at: latest },
    });
    await updateRecord(tx, 'patients', { id: mergeId, version: Number(gone.version), by, reason: `merged into ${String(keep.uhid)}`, set: { merged_into: keepId } });
    return toMerge(await updateRecord(tx, 'patient_merges', { ...change, set: { status: 'approved', approved_by: by, moved_rows: JSON.stringify(moved) } }));
  });
}
