import { App } from 'aws-cdk-lib';
import { EhrStack } from './ehr-stack.js';

const app = new App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
const alertEmail: string | undefined = app.node.tryGetContext('alertEmail') || undefined;

new EhrStack(app, `ehr-${stage}`, {
  stage,
  alertEmail,
  // Mumbai only. The account is the one whose credentials run the deploy.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' },
});
