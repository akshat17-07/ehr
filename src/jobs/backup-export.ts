import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AGE_RECIPIENT, encryptForBackup } from '../backup/encrypt.js';
import { s3Backup } from '../backup/files.js';
import { env } from '../config/env.js';
import type { Queryable } from '../db/migrate.js';
import { indiaDate } from '../time/india.js';
import type { JobDeps } from './alert-digest.js';
import { recordRun as record, type RunRow } from './job-runs.js';

const JOB = 'backup_export';
const PAGE = 1000;
export const PART_ROWS = 5000;

// The export is NOT one point-in-time snapshot across tables: reading everything in one long DSQL transaction is not
// possible, so each table is read on its own. That is acceptable because nothing is ever deleted and every edit keeps
// its old version (<table>_versions), so a row seen late is never missing, only newer. The restore test checks this.

/** One value as written to NDJSON: dates as ISO text, bytea as {"$b64": ...}, everything else as pg returned it. */
export function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v).toString('base64') };
  return v;
}

interface Part {
  key: string;
  rows: number;
  sizeBytes: number;
  sha256: string;
}
interface TableEntry {
  name: string;
  rows: number;
  parts: Part[];
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** #500: nightly full export of every table, gzip + age encrypted, to the backup bucket. The manifest is written last. */
export async function backupExport({ db, now = new Date(), backupFiles }: JobDeps, partRows = PART_ROWS, pageSize = PAGE): Promise<void> {
  const startedAt = new Date();
  const runId = randomUUID();
  const recordRun = (run: Omit<RunRow, 'job' | 'startedAt'>) => record(db, { job: JOB, startedAt, ...run });

  const recipient = env.BACKUP_AGE_RECIPIENT;
  const files = backupFiles ?? (env.BACKUP_BUCKET ? s3Backup : undefined);
  if (!recipient || !files) {
    if (env.STAGE === 'prod') {
      await recordRun({ ok: false, detail: { error: 'no backup config' } });
      throw new Error('Backup bucket or age recipient is not configured');
    }
    console.warn(JSON.stringify({ msg: 'job warning', job: JOB, warning: 'no backup config, database not exported' }));
    await recordRun({ ok: true, detail: { skipped: 'no backup config' } });
    return;
  }
  if (!AGE_RECIPIENT.test(recipient)) {
    await recordRun({ ok: false, detail: { error: 'bad recipient' } });
    throw new Error('BACKUP_AGE_RECIPIENT is not a valid age recipient');
  }

  const [y, m, d] = indiaDate(now).split('-');
  const prefix = `backup/${env.STAGE}/${y}/${m}/${d}/${runId}`;
  let table: string | undefined;
  try {
    const tables: TableEntry[] = [];
    let totalBytes = 0;
    for (table of await listTables(db)) {
      const entry: TableEntry = { name: table, rows: 0, parts: [] };
      const flush = async (lines: string[]) => {
        const body = await encryptForBackup(gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')), recipient);
        const key = `${prefix}/${entry.name}/${String(entry.parts.length + 1).padStart(4, '0')}.ndjson.gz.age`;
        await files.put(key, body);
        entry.parts.push({ key, rows: lines.length, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
        entry.rows += lines.length;
        totalBytes += body.length;
      };
      let buffer: string[] = [];
      for await (const row of readRows(db, table, pageSize)) {
        buffer.push(JSON.stringify(row));
        if (buffer.length >= partRows) {
          await flush(buffer);
          buffer = [];
        }
      }
      if (buffer.length > 0) await flush(buffer);
      tables.push(entry);
    }
    // Written last: a run without a manifest is incomplete by definition.
    const manifest = { version: 1, runId, stage: env.STAGE, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), tables };
    const body = await encryptForBackup(Buffer.from(JSON.stringify(manifest), 'utf8'), recipient);
    const manifestKey = `${prefix}/manifest.json.age`;
    await files.put(manifestKey, body);
    totalBytes += body.length;
    const rows = tables.reduce((n, t) => n + t.rows, 0);
    const parts = tables.reduce((n, t) => n + t.parts.length, 0);
    await recordRun({ ok: true, detail: { runId, tables: tables.length, rows, parts }, s3Key: manifestKey, sizeBytes: totalBytes });
    console.log(JSON.stringify({ msg: 'job summary', job: JOB, runId, tables: tables.length, rows, parts, key: manifestKey, sizeBytes: totalBytes }));
  } catch (error) {
    await recordRun({ ok: false, detail: { error: error instanceof Error ? error.message : 'export failed', runId, ...(table && { table }) } });
    throw error;
  }
}

async function listTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => String(r.table_name));
}

/** Every row of one table, as objects ready for JSON. Keyset paging on the primary key. */
async function* readRows(db: Queryable, table: string, page: number): AsyncGenerator<Record<string, unknown>> {
  const { rows: cols } = await db.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
  const names = cols.map((c) => String(c.column_name));
  // pg turns date/time columns into JS Dates in the server's time zone; read them as text so they restore exactly.
  const select = cols
    .map((c) => (/^(date|time without time zone|time with time zone)$/.test(String(c.data_type)) ? `${quote(String(c.column_name))}::text AS ${quote(String(c.column_name))}` : quote(String(c.column_name))))
    .join(', ');
  const t = quote(table);
  const encode = (r: Record<string, unknown>) => Object.fromEntries(names.map((n) => [n, encodeValue(r[n])]));

  const { rows: keyRows } = await db.query(
    `SELECT k.column_name FROM information_schema.table_constraints c
     JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.constraint_type = 'PRIMARY KEY' ORDER BY k.ordinal_position`,
    [table],
  );
  const pk = keyRows.map((r) => quote(String(r.column_name)));
  const pkNames = keyRows.map((r) => String(r.column_name));
  if (pk.length === 0) {
    console.warn(JSON.stringify({ msg: 'job warning', job: JOB, warning: 'table has no primary key, read in one query', table }));
    const { rows } = await db.query(`SELECT ${select} FROM ${t} ORDER BY ${quote(names[0]!)}`);
    for (const r of rows) yield encode(r);
    return;
  }
  // Keyset paging on the primary key (composite for history tables), so memory stays at one page.
  const order = pk.join(', ');
  let last: unknown[] | undefined;
  for (;;) {
    const where = last ? `WHERE (${order}) > (${last.map((_, i) => `$${i + 1}`).join(', ')}) ` : '';
    const { rows } = await db.query(`SELECT ${select} FROM ${t} ${where}ORDER BY ${order} LIMIT ${page}`, last ?? []);
    for (const r of rows) yield encode(r);
    if (rows.length < page) return;
    const end = rows[rows.length - 1]!;
    last = pkNames.map((n) => end[n]);
  }
}
