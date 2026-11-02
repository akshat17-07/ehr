import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';
import { assertNotCancelled, getSurgery } from '../surgeries/surgeries.js';

// Ortho implants (api-list.md Implant): what went into the patient, by batch, so a recall can find them.

export interface Implant extends BaseFields {
  surgeryId: string;
  patientId: string;
  name: string;
  manufacturer?: string;
  batchNo: string;
  size?: string;
  stickerDocumentId?: string;
  mrpPaise: number;
}

export function toImplant(r: Record<string, unknown>): Implant {
  return {
    ...baseFields(r as unknown as BaseRow),
    surgeryId: String(r.surgery_id),
    patientId: String(r.patient_id),
    name: String(r.name),
    ...(r.manufacturer != null && { manufacturer: String(r.manufacturer) }),
    batchNo: String(r.batch_no),
    ...(r.size != null && { size: String(r.size) }),
    ...(r.sticker_document_id != null && { stickerDocumentId: String(r.sticker_document_id) }),
    mrpPaise: Number(r.mrp_paise),
  };
}

export interface NewImplant {
  name: string;
  manufacturer?: string;
  batchNo: string;
  size?: string;
  mrpPaise: number;
}

/** #85: 409 for a cancelled surgery. */
export async function addImplant(db: Queryable, surgeryId: string, input: NewImplant, by: string): Promise<Implant> {
  const surgery = await getSurgery(db, surgeryId);
  assertNotCancelled(surgery);
  const { rows } = await db.query(
    `INSERT INTO implants (id, status, created_by, updated_by, surgery_id, patient_id, name, manufacturer, batch_no, size, mrp_paise)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [randomUUID(), by, surgery.id, surgery.patientId, input.name, input.manufacturer ?? null, input.batchNo, input.size ?? null, input.mrpPaise],
  );
  return toImplant(rows[0] as Record<string, unknown>);
}

/** A surgery's implants, in the order they were recorded. */
export async function surgeryImplants(db: Queryable, surgeryId: string): Promise<Implant[]> {
  const { rows } = await db.query('SELECT * FROM implants WHERE surgery_id = $1 AND voided_at IS NULL ORDER BY created_at, id', [surgeryId]);
  return rows.map(toImplant);
}
