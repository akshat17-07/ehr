import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * CloudTrail: who did what in this AWS account (console clicks, deploys, IAM changes), in every region.
 * The first trail's management events are free; only the S3 storage is paid.
 * Log file validation proves the logs weren't changed. Kept 400 days (CERT-In asks for 180 days in India).
 */
export class AuditTrail extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { id: 'expire-after-400-days', expiration: Duration.days(400), noncurrentVersionExpiration: Duration.days(400) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new cloudtrail.Trail(this, 'Trail', {
      bucket: this.bucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });
  }
}
