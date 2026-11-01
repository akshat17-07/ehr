import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';

// A patient's timeline (#25, api-list.md TimelineItem): their encounters, notes, prescriptions, documents, bills,
// surgeries and admissions, newest first, in one list. Each module adds its table to TIMELINE_SOURCES when it is built.

export const TIMELINE_KINDS = ['encounter', 'note', 'prescription', 'document', 'bill', 'surgery', 'admission'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineItem {
  kind: TimelineKind;
  id: string;
  at: string;
  title: string;
}

export interface TimelineSource {
  kind: TimelineKind;
  /** A record table with a patient_id column. Voided rows are left out. */
  table: string;
  /** The timestamptz column the item is dated by. */
  at: string;
  /** A SQL text expression for the title, e.g. `'OPD visit: ' || department_name`. */
  title: string;
}

/** Filled in by each module (none are built yet). */
export const TIMELINE_SOURCES: TimelineSource[] = [];

const NAME = /^[a-z][a-z0-9_]*$/;

export interface TimelineQuery extends PageQuery {
  /** India dates (YYYY-MM-DD), both days included. */
  from?: string;
  to?: string;
  kind?: TimelineKind;
}

/** The start of an India day as a time. */
const dayStart = (date: string) => new Date(`${date}T00:00:00+05:30`);

export async function patientTimeline(db: Queryable, patientId: string, query: TimelineQuery): Promise<Page<TimelineItem>> {
  const sources = TIMELINE_SOURCES.filter((s) => !query.kind || s.kind === query.kind);
  if (sources.length === 0) return { items: [] };
  for (const s of sources) if (!NAME.test(s.table) || !NAME.test(s.at)) throw new Error(`Bad timeline source: ${s.table}`);

  const union = sources
    .map((s) => `SELECT '${s.kind}' AS kind, id, ${s.at} AS at, ${s.title} AS title FROM ${s.table} WHERE patient_id = $1 AND voided_at IS NULL`)
    .join(' UNION ALL ');
  const where: string[] = [];
  const params: unknown[] = [patientId];
  if (query.from) where.push(`at >= $${params.push(dayStart(query.from))}`);
  if (query.to) where.push(`at < $${params.push(new Date(dayStart(query.to).getTime() + 86_400_000))}`);

  return pageRows(db, { select: `SELECT * FROM (${union}) AS timeline`, where, params, orderBy: ['at', 'id'] }, query, (r) => ({
    kind: r.kind as TimelineKind,
    id: String(r.id),
    at: (r.at as Date).toISOString(),
    title: String(r.title),
  }));
}
