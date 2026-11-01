import type { App } from 'aws-cdk-lib';

// Everything in ap-south-1 (Mumbai). Nothing in this app may use another region.
export const REGION = 'ap-south-1';

export interface StageConfig {
  stage: string;
  prod: boolean;
  /** Error alarms are emailed here. AWS first sends a "confirm subscription" email. */
  alertEmail?: string;
  /** AWS account 2 ("backup"). When set, files are replicated there and the nightly export can write there. */
  backupAccountId?: string;
  /** GitHub repo of the website (`owner/name`). Its main branch may upload the website, nothing else. */
  frontendRepo: string;
}

// Values come from `cdk.json` context or `-c key=value` on the command line.
export function readConfig(app: App): StageConfig {
  const ctx = (key: string): string | undefined => {
    const value: unknown = app.node.tryGetContext(key);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const stage = ctx('stage') ?? 'dev';
  return {
    stage,
    prod: stage === 'prod',
    alertEmail: ctx('alertEmail'),
    backupAccountId: ctx('backupAccountId'),
    frontendRepo: ctx('frontendRepo') ?? 'akshat17-07/ehr-frontend',
  };
}

/** Fixed names, so the backup account (a different account) can refer to them. */
export const names = {
  apiRole: (stage: string) => `ehr-${stage}-api`,
  replicationRole: (stage: string) => `ehr-${stage}-files-replication`,
  backupBucket: (stage: string, backupAccountId: string) => `ehr-${stage}-backup-${backupAccountId}`,
};
