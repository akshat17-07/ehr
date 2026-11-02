// Inventory items (api-list.md Item). Drugs are items too (kind drug, same id, unit from the form); the rest live
// in items. ITEMS reads both as one list.

export const ITEM_KINDS = ['drug', 'consumable', 'surgical', 'implant', 'lab_reagent', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Item {
  id: string;
  version: number;
  name: string;
  kind: ItemKind;
  unit: string;
  packSize?: number;
  hsn?: string;
  gstRate?: number;
  mrpPaise?: number;
  active: boolean;
  qtyOnHand: number;
  qtyUsable: number;
}

/** Drugs and other items as one table, `i` (use with WHERE on i.*). */
export const ITEMS = `SELECT * FROM (
  SELECT id, version, name, 'drug' AS kind, COALESCE(form, 'unit') AS unit, NULL::integer AS pack_size, hsn, gst_rate, mrp_paise, active
  FROM drugs
  UNION ALL
  SELECT id, version, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active FROM items
) AS i`;

export function toItem(r: Record<string, unknown>, qty: { qtyOnHand: number; qtyUsable: number }): Item {
  return {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    kind: r.kind as ItemKind,
    unit: String(r.unit),
    ...(r.pack_size != null && { packSize: Number(r.pack_size) }),
    ...(r.hsn != null && { hsn: String(r.hsn) }),
    ...(r.gst_rate != null && { gstRate: Number(r.gst_rate) }),
    ...(r.mrp_paise != null && { mrpPaise: Number(r.mrp_paise) }),
    active: r.active === true,
    ...qty,
  };
}
