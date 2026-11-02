import { describe, expect, it } from 'vitest';
import { s3Uploads } from '../src/files/uploads.js';

// The real signer, offline (no request is sent): the link must bind the file's type, size and SHA-256.
describe('s3Uploads.signPut', () => {
  it('signs content-type, content-length and the SHA-256 checksum header', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    const sha256 = 'ab'.repeat(32);
    const { url, headers } = await s3Uploads.signPut('files-test', 'patients/p/d', { mime: 'image/png', sizeBytes: 1234, sha256 }, 900);
    const signed = new URL(url);
    expect(signed.host).toBe('files-test.s3.ap-south-1.amazonaws.com');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(signed.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host', 'x-amz-checksum-sha256']));
    expect(headers).toEqual({ 'content-type': 'image/png', 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') });
  });
});
