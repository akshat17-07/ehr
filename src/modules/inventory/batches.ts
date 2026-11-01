import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { UUID } from '../users/users.js';

// Stock batches (api-list.md Batch). Quantities change only through stock movements (GRN, dispense, quarantine…);
// quarantined stock stays on hand but can't be used. A batch can be used up to and on its expiry date.

export interface Batch {
  id: string;
  version: number;
  itemId: string;
  batchNo: string;
  /** YYYY-MM-DD */
  expiry: string;
  supplierId?: string;
  costPaise: number;
  mrpPaise: number;
  qtyOnHand: number;
  qtyQuarantined: number;
  /** On hand − quarantined, and 0 if expired or recalled. */
  qtyUsable: number;
  recalled: boolean;
}

function toBatch(r: Record<string, unknown>, today: string): Batch {
  const expiry = String(r.expiry_text);
  const onHand = Number(r.qty_on_hand);
  const quarantined = Number(r.qty_quarantined);
  const recalled = r.recalled === true;
  const batch: Batch = {
    id: String(r.id),
    version: Number(r.version),
    itemId: String(r.item_id),
    batchNo: String(r.batch_no),
    expiry,
    costPaise: Number(r.cost_paise),
    mrpPaise: Number(r.mrp_paise),
    qtyOnHand: onHand,
    qtyQuarantined: quarantined,
    qtyUsable: recalled || expiry < today ? 0 : Math.max(0, onHand - quarantined),
    recalled,
  };
  if (r.supplier_id != null) batch.supplierId = String(r.supplier_id);
  return batch;
}

/** #13: a drug's batches, first to expire first (FEFO). `inStock` keeps only batches with usable stock. 404 for an unknown drug. */
export async function listDrugBatches(db: Queryable, drugId: string, filter: { inStock?: boolean } = {}, now = new Date()): Promise<Batch[]> {
  const drug = UUID.test(drugId) ? (await db.query('SELECT id FROM drugs WHERE id = $1', [drugId])).rows[0] : undefined;
  if (!drug) throw new AppError(404, 'not_found');

  const today = indiaDate(now);
  const { rows } = await db.query(
    // The date as text, so no time zone can move it a day.
    'SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE item_id = $1 ORDER BY expiry, batch_no, id',
    [drugId],
  );
  const batches = rows.map((r) => toBatch(r, today));
  return filter.inStock === undefined ? batches : batches.filter((b) => b.qtyUsable > 0 === filter.inStock);
}
