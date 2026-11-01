import { App } from 'aws-cdk-lib';
import { BackupStack } from './backup-stack.js';
import { REGION, readConfig } from './config.js';
import { EhrStack } from './ehr-stack.js';

const app = new App();
const config = readConfig(app);

// Stack 1, in the app account: `cdk deploy ehr-<stage>`.
new EhrStack(app, `ehr-${config.stage}`, {
  config,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
});

// Stack 2, in the backup account (deployed with that account's credentials): `cdk deploy ehr-backup-<stage>`.
// Needs both account IDs: -c backupAccountId=<account 2> -c appAccountId=<account 1>.
const appAccountId: unknown = app.node.tryGetContext('appAccountId');
if (config.backupAccountId && typeof appAccountId === 'string' && appAccountId !== '') {
  new BackupStack(app, `ehr-backup-${config.stage}`, {
    config,
    appAccountId,
    env: { account: config.backupAccountId, region: REGION },
  });
}
