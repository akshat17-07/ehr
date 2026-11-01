import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
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
    const { config, appAccountId } = props;

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

    const appAccount = new iam.AccountPrincipal(appAccountId);
    const appRole = (name: string) => `arn:aws:iam::${appAccountId}:role/${name}`;

    // S3 replication from the app account's files bucket.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'ReplicationFromAppAccount',
        principals: [appAccount],
        actions: ['s3:ReplicateObject', 's3:ReplicateTags', 's3:ObjectOwnerOverrideToBucketOwner'],
        resources: [bucket.arnForObjects('*')],
        conditions: { ArnEquals: { 'aws:PrincipalArn': appRole(names.replicationRole(config.stage)) } },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'ReplicationCheckVersioning',
        principals: [appAccount],
        actions: ['s3:GetBucketVersioning', 's3:PutBucketVersioning', 's3:List*'],
        resources: [bucket.bucketArn],
        conditions: { ArnEquals: { 'aws:PrincipalArn': appRole(names.replicationRole(config.stage)) } },
      }),
    );
    // Nightly export from the API Lambda: add files under exports/ only.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'NightlyExportFromApi',
        principals: [appAccount],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('exports/*')],
        conditions: { ArnEquals: { 'aws:PrincipalArn': appRole(names.apiRole(config.stage)) } },
      }),
    );
    // Nobody in the app account may delete, change retention or change the rules, whatever their own IAM says.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AppAccountNeverDeletes',
        effect: iam.Effect.DENY,
        principals: [appAccount],
        actions: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:PutObjectRetention',
          's3:PutObjectLegalHold',
          's3:BypassGovernanceRetention',
          's3:PutLifecycleConfiguration',
          's3:PutBucketPolicy',
          's3:DeleteBucketPolicy',
          's3:PutBucketObjectLockConfiguration',
        ],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
      }),
    );

    new CfnOutput(this, 'BackupBucket', { value: bucket.bucketName });
  }
}
