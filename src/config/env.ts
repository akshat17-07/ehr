import { z } from 'zod';

// All environment variables the API reads, validated once at start-up.
// Values are set by infra/constructs/api.ts in AWS, or by the developer locally.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  AWS_REGION: z.string().default('ap-south-1'),
  STAGE: z.string().default('dev'),
  DSQL_ENDPOINT: z.string().optional(),
  DB_USER: z.string().default('ehr_app'),
  STAFF_POOL_ID: z.string().optional(),
  PATIENT_POOL_ID: z.string().optional(),
  FILES_BUCKET: z.string().optional(),
  EXPORTS_BUCKET: z.string().optional(),
  BACKUP_BUCKET: z.string().optional(),
  // Local only: folder of the embedded Postgres used when DSQL_ENDPOINT is not set.
  LOCAL_DB_DIR: z.string().default('.data/db'),
  // Migration Lambda only.
  API_ROLE_ARN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`Environment variable ${key} is not set`);
  return value as NonNullable<Env[K]>;
}
