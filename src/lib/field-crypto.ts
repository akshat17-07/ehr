import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AppError } from '../middleware/errors.js';

// Field-level encryption for payroll data (PAN, UAN, ESIC, bank details): AES-256-GCM with an app key.
// Stored as "v1:<iv>:<tag>:<ciphertext>" (base64). The key is SHA-256 of a secret string: FIELD_KEY (tests, local),
// or the Secrets Manager secret named by FIELD_KEY_SECRET_ARN (AWS; infra/constructs/api.ts). Losing the key loses the data.

const VERSION = 'v1';
const DEV_KEY = 'ehr-local-dev-field-key-not-for-production';

let keyPromise: Promise<Buffer> | undefined;
let warned = false;

async function loadSecret(): Promise<string> {
  if (process.env.FIELD_KEY) return process.env.FIELD_KEY;
  const arn = process.env.FIELD_KEY_SECRET_ARN;
  if (arn) {
    const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    if (!res.SecretString) throw new AppError(500, 'field_key_missing');
    return res.SecretString;
  }
  if (!process.env.STAGE) {
    if (!warned) {
      warned = true;
      console.warn('FIELD_KEY is not set: using the fixed local dev key for field encryption');
    }
    return DEV_KEY;
  }
  throw new AppError(500, 'field_key_missing');
}

/** The 32-byte key, read once; a failed read is not cached, so the next call tries again. */
function fieldKey(): Promise<Buffer> {
  keyPromise ??= loadSecret()
    .then((secret) => createHash('sha256').update(secret).digest())
    .catch((err: unknown) => {
      keyPromise = undefined;
      throw err;
    });
  return keyPromise;
}

export async function encryptField(plain: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await fieldKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Throws when the text is not in the v1 format or was changed (or made with another key). */
export async function decryptField(stored: string): Promise<string> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('bad encrypted field format');
  const [, iv, tag, data] = parts.map((p) => Buffer.from(p ?? '', 'base64')) as [Buffer, Buffer, Buffer, Buffer];
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad encrypted field format');
  const decipher = createDecipheriv('aes-256-gcm', await fieldKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** '****' + the last 4 characters (all of them when shorter). */
export const maskField = (plain: string): string => `****${plain.slice(-4)}`;

/** Keyed hash (HMAC-SHA256, hex) for looking up or de-duplicating a field. `domain` (e.g. 'aadhaar:') keeps fields apart. */
export async function hashField(domain: string, plain: string): Promise<string> {
  return createHmac('sha256', await fieldKey()).update(`${domain}${plain}`).digest('hex');
}
