import { env } from '../config/env.js';

// Signed links to private S3 files: the browser downloads straight from S3, and the link stops working after
// `seconds`. The API stays the only way to get one, so every download is checked and audited.

export type SignGetUrl = (bucket: string, key: string, seconds: number) => Promise<string>;

export const signGetUrl: SignGetUrl = async (bucket, key, seconds) => {
  const [{ S3Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ]);
  const client = new S3Client({ region: env.AWS_REGION });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds });
};

/** How long a view or download link works (api-list.md: 10 minutes). */
export const LINK_SECONDS = 10 * 60;
