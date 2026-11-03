import { stockAlerts } from '../modules/inventory/stock.js';
import { usersWithPermission } from '../permissions/check.js';
import { indiaDate, indiaDayStart } from '../time/india.js';
import { logSummary, raiseIfChanged, type Digest, type JobDeps, type Tally } from './alert-digest.js';

const JOB = 'stock_scan';
const DAY_MS = 86_400_000;
const NAMES_SHOWN = 5;

/** #502: nightly digest of expiring and recalled stock for everyone with stock.view. Low stock is never an alert. */
export async function stockScan({ db, now = new Date() }: JobDeps): Promise<void> {
  const today = indiaDate(now);
  const in30 = indiaDate(new Date(indiaDayStart(today).getTime() + 30 * DAY_MS));
  // Same query as #111 (first to expire first, stock not already set aside).
  const found = await stockAlerts(db, {}, now);
  let expired = 0;
  let soon = 0;
  let later = 0;
  for (const a of found.filter((x) => x.kind === 'expiry')) {
    if (a.batch.expiry < today) expired++;
    else if (a.batch.expiry <= in30) soon++;
    else later++;
  }
  const recalled = found.filter((x) => x.kind === 'recall').map((x) => `${x.item.name} ${x.batch.batchNo}`).sort();

  const digests: Digest[] = [];
  if (expired + soon + later > 0) {
    digests.push({
      kind: 'expiry',
      title: 'Stock expiry',
      body: `Expired with stock: ${expired}. Expiring in 30 days: ${soon}. Expiring in 31-90 days: ${later}.`,
      link: '/stock/alerts?kind=expiry',
    });
  }
  if (recalled.length > 0) {
    const more = recalled.length > NAMES_SHOWN ? `, and ${recalled.length - NAMES_SHOWN} more` : '';
    digests.push({
      kind: 'recall',
      title: 'Recalled stock on hand',
      body: `Recalled batches with stock: ${recalled.length}. ${recalled.slice(0, NAMES_SHOWN).join(', ')}${more}.`,
      link: '/stock/alerts?kind=recall',
    });
  }

  const tally: Tally = { alertsCreated: 0, skippedUnchanged: 0 };
  if (digests.length > 0) {
    for (const userId of await usersWithPermission(db, 'stock.view', now)) {
      for (const digest of digests) await raiseIfChanged(db, userId, digest, JOB, tally);
    }
  }
  logSummary(JOB, tally);
}
