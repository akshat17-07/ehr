import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { names, type StageConfig } from '../config.js';

export interface FilesProps {
  config: StageConfig;
  /** Website addresses allowed to upload straight to S3 with a signed link. */
  allowedOrigins: string[];
}

/**
 * Two buckets, both private, encrypted (SSE-S3) and HTTPS only.
 *
 * files:   patient documents (prescription photos, reports). Versioned and protected by Object Lock:
 *            dev:  governance mode, 1 day    (test files can be cleaned up)
 *            prod: compliance mode, 10 years (nobody, including the root user, can delete)
 *          Moves to Glacier Instant Retrieval after 90 days (same speed to open, ~80% cheaper).
 *          Copied to the backup account when `backupAccountId` is set (Backup 1).
 *
 * exports: short-lived copies only (record-copy PDFs, FHIR exports). Deleted after 7 days.
 */
export class Files extends Construct {
  readonly bucket: s3.Bucket;
  readonly exportsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FilesProps) {
    super(scope, id);
    const { config } = props;

    const cors: s3.CorsRule[] = [
      {
        allowedOrigins: props.allowedOrigins,
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      },
    ];

    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: config.prod
        ? s3.ObjectLockRetention.compliance(Duration.days(3653))
        : s3.ObjectLockRetention.governance(Duration.days(1)),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors,
      lifecycleRules: [
        {
          id: 'glacier-instant-retrieval-after-90-days',
          transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) }],
          noncurrentVersionTransitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) },
          ],
        },
        { id: 'abort-unfinished-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      ...(config.backupAccountId ? this.replication(config, config.backupAccountId) : {}),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.exportsBucket = new s3.Bucket(this, 'ExportsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors,
      lifecycleRules: [{ id: 'delete-after-7-days', expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  // Upload and read only. The API never gets permission to delete patient files.
  grantPutAndRead(grantee: iam.IGrantable): void {
    this.bucket.grantPut(grantee);
    this.bucket.grantRead(grantee);
    this.exportsBucket.grantPut(grantee);
    this.exportsBucket.grantRead(grantee);
  }

  // Copies every new file to the locked bucket in the backup account. Deletes are never copied.
  private replication(config: StageConfig, backupAccountId: string): Partial<s3.BucketProps> {
    const role = new iam.Role(this, 'ReplicationRole', {
      roleName: names.replicationRole(config.stage),
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
    });
    const destination = s3.Bucket.fromBucketAttributes(this, 'BackupBucket', {
      bucketName: names.backupBucket(config.stage, backupAccountId),
      account: backupAccountId,
    });
    return {
      replicationRole: role,
      replicationRules: [
        {
          destination,
          priority: 1,
          accessControlTransition: true, // the copy is owned by the backup account
          storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
          deleteMarkerReplication: false,
        },
      ],
    };
  }
}
