import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Clinical notes (api-list.md Note): written as a draft, edited by its author, then signed. A signed note never
// changes; anything later goes in an addendum. Nursing notes are signed when saved.

export const NOTE_KINDS = ['progress', 'consult', 'procedure', 'nursing'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_STATUSES = ['draft', 'signed'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface Addendum {
  text: string;
  by: string;
  at: string;
}

export interface Note extends Omit<BaseFields, 'status'> {
  status: NoteStatus;
  encounterId: string;
  patientId: string;
  kind: NoteKind;
  text: string;
  signedAt?: string;
  signedBy?: string;
  addenda: Addendum[];
}

export function toNote(r: Record<string, unknown>): Note {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as NoteStatus,
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    kind: r.kind as NoteKind,
    text: String(r.text),
    ...(r.signed_at instanceof Date && { signedAt: r.signed_at.toISOString(), signedBy: String(r.signed_by) }),
    addenda: JSON.parse(String(r.addenda ?? '[]')) as Addendum[],
  };
}

export interface NewNote {
  kind: Exclude<NoteKind, 'nursing'>;
  text: string;
}

/** #45: a draft note in an open encounter. */
export async function addNote(db: Queryable, encounterId: string, input: NewNote, by: string): Promise<Note> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const { rows } = await db.query(
    `INSERT INTO notes (id, status, created_by, updated_by, encounter_id, patient_id, kind, text, addenda)
     VALUES ($1, 'draft', $2, $2, $3, $4, $5, $6, '[]') RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, input.kind, input.text],
  );
  return toNote(rows[0] as Record<string, unknown>);
}

/** The notes of one encounter, oldest first (for #38). */
export async function encounterNotes(db: Queryable, encounterId: string): Promise<Note[]> {
  const { rows } = await db.query('SELECT * FROM notes WHERE encounter_id = $1 AND voided_at IS NULL ORDER BY created_at, id', [encounterId]);
  return rows.map(toNote);
}

/** How many notes of the encounter are still drafts (an encounter closes only with none, #40). */
export async function draftNoteCount(db: Queryable, encounterId: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM notes WHERE encounter_id = $1 AND status = 'draft' AND voided_at IS NULL",
    [encounterId],
  );
  return Number(rows[0]?.n ?? 0);
}
