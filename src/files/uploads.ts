import { env } from '../config/env.js';

// Uploads straight from the browser to the files bucket. The API signs a PUT for one file: its type, its size and
// its SHA-256 are part of the signature, so S3 refuses any other body. After the upload the API checks the stored
// object (head) before the document counts as ready.

export interface UploadFile {
  mime: string;
  sizeBytes: number;
  /** Hex. */
  sha256: string;
}

export interface StoredFile {
  sizeBytes: number;
  /** Hex; missing if S3 has no SHA-256 for the object. */
  sha256?: string;
}

export interface FileUploads {
  /** A signed PUT link and the headers the browser must send with it. */
  signPut(bucket: string, key: string, file: UploadFile, seconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** The stored object's size and SHA-256; undefined if nothing is there. */
  head(bucket: string, key: string): Promise<StoredFile | undefined>;
}

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const base64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

async function s3() {
  const sdk = await import('@aws-sdk/client-s3');
  // Only the checksum we sign: the SDK's own default checksums would change the signed request.
  return { sdk, client: new sdk.S3Client({ region: env.AWS_REGION, requestChecksumCalculation: 'WHEN_REQUIRED' }) };
}

export const s3Uploads: FileUploads = {
  async signPut(bucket, key, file, seconds) {
    const [{ sdk, client }, { getSignedUrl }] = await Promise.all([s3(), import('@aws-sdk/s3-request-presigner')]);
    const checksum = hexToBase64(file.sha256);
    const command = new sdk.PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: file.mime,
      ContentLength: file.sizeBytes,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(client, command, {
      expiresIn: seconds,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    // The browser sets content-length itself; it must match the signed size.
    return { url, headers: { 'content-type': file.mime, 'x-amz-checksum-sha256': checksum } };
  },

  async head(bucket, key) {
    const { sdk, client } = await s3();
    try {
      const res = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
      return { sizeBytes: Number(res.ContentLength), ...(res.ChecksumSHA256 && { sha256: base64ToHex(res.ChecksumSHA256) }) };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return undefined;
      throw err;
    }
  },
};

/** How long an upload link works. */
export const UPLOAD_SECONDS = 15 * 60;
