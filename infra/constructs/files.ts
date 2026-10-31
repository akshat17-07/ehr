import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface FilesProps {
  prod: boolean;
}

/**
 * Bucket for patient documents (prescription photos, reports).
 * Never public, versioned, encrypted, and protected by Object Lock:
 *   dev:  governance mode, 1 day   (test files can be cleaned up)
 *   prod: compliance mode, 10 years (nobody, including the root user, can delete)
 */
export class Files extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FilesProps) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: props.prod
        ? s3.ObjectLockRetention.compliance(Duration.days(3653))
        : s3.ObjectLockRetention.governance(Duration.days(1)),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  // Upload and read only. The API never gets permission to delete files.
  grantPutAndRead(grantee: iam.IGrantable): void {
    this.bucket.grantPut(grantee);
    this.bucket.grantRead(grantee);
  }
}
