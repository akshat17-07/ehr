import { env, requireEnv } from '../config/env.js';

// Backup 1: the Object Lock bucket in the backup account. The API role may only write there (never read or delete),
// so a put is the only operation. Keys are unique per range, so nothing is ever overwritten.

export interface BackupFiles {
  put(key: string, body: Uint8Array): Promise<void>;
}

export const s3Backup: BackupFiles = {
  async put(key, body) {
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({ region: env.AWS_REGION });
    await client.send(new sdk.PutObjectCommand({ Bucket: requireEnv('BACKUP_BUCKET'), Key: key, Body: body, ContentType: 'application/octet-stream' }));
  },
};
