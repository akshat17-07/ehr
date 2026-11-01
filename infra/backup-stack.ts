import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { names, type StageConfig } from './config.js';

export interface BackupStackProps extends StackProps {
  config: StageConfig;
  /** AWS account 1, where the app runs. */
  appAccountId: string;
}

/**
 * Backup 1, in AWS account 2 (deployed with that account's credentials, before the app stack sets backupAccountId).
 *   - files/   copy of every patient file (S3 replication from the app account)
 *   - exports/ nightly encrypted database export (written by the API Lambda)
 * The app account can only add objects here, never delete. Object Lock stops deletes even inside this account.
 * Backup 2 is the hospital PC: a read-only user downloads the nightly export (access key made in the console).
 */
export class BackupStack extends Stack {
  constructor(scope: Construct, id: string, props: BackupStackProps) {
    super(scope, id, props);
    const { config } = props;

    Tags.of(this).add('app', 'ehr');
    Tags.of(this).add('stage', config.stage);

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: names.backupBucket(config.stage, this.account),
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: config.prod
        ? s3.ObjectLockRetention.compliance(Duration.days(3653))
        : s3.ObjectLockRetention.governance(Duration.days(1)),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'exports-glacier-instant-retrieval-after-30-days',
          prefix: 'exports/',
          transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(30) }],
        },
        { id: 'abort-unfinished-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'BackupBucket', { value: bucket.bucketName });
  }
}
