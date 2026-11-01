// Database changes, in order. Never edit or remove one that has run; add a new one instead.
// Aurora DSQL rules: one DDL statement per transaction (each string below runs on its own),
// no foreign keys or triggers, and indexes are created with `CREATE INDEX ASYNC`.
// Every new table must `GRANT SELECT, INSERT, UPDATE ON <table> TO ehr_app` (never DELETE).

export interface MigrationContext {
  /** IAM role of the API Lambda; it logs in as ehr_app. */
  apiRoleArn: string;
}

export interface Migration {
  id: string;
  statements: (ctx: MigrationContext) => string[];
}

export const migrations: Migration[] = [];
