import { env, requireEnv } from '../config/env.js';

// Short-lived copies made by the API (record copies, FHIR exports) in the exports bucket, which deletes them after
// 7 days. Read back only through signed links (signed-url.ts).

export interface ExportFiles {
  /** `contentEncoding: 'gzip'` when `body` is already gzipped bytes (the full FHIR export). */
  put(key: string, body: string | Uint8Array, mime: string, contentEncoding?: 'gzip'): Promise<void>;
}

export const s3Exports: ExportFiles = {
  async put(key, body, mime, contentEncoding) {
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({ region: env.AWS_REGION });
    await client.send(new sdk.PutObjectCommand({ Bucket: requireEnv('EXPORTS_BUCKET'), Key: key, Body: body, ContentType: mime, ...(contentEncoding && { ContentEncoding: contentEncoding }) }));
  },
};
