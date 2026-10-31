import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Api } from './constructs/api.js';
import { Auth } from './constructs/auth.js';
import { Database } from './constructs/database.js';
import { Files } from './constructs/files.js';
import { Monitoring } from './constructs/monitoring.js';

export interface EhrStackProps extends StackProps {
  stage: string;
  alertEmail?: string;
}

// The whole backend for one stage (dev / prod) in ap-south-1.
export class EhrStack extends Stack {
  constructor(scope: Construct, id: string, props: EhrStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';

    Tags.of(this).add('app', 'ehr');
    Tags.of(this).add('stage', props.stage);

    const database = new Database(this, 'Database');
    const files = new Files(this, 'Files', { prod });
    const auth = new Auth(this, 'Auth', { prod });
    const api = new Api(this, 'Api', { stage: props.stage, database, files, auth });
    new Monitoring(this, 'Monitoring', { apiFunction: api.function, alertEmail: props.alertEmail });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'DsqlEndpoint', { value: database.endpoint });
    new CfnOutput(this, 'FilesBucket', { value: files.bucket.bucketName });
    new CfnOutput(this, 'StaffPoolId', { value: auth.staff.pool.userPoolId });
    new CfnOutput(this, 'StaffClientId', { value: auth.staff.client.userPoolClientId });
    new CfnOutput(this, 'PatientPoolId', { value: auth.patient.pool.userPoolId });
    new CfnOutput(this, 'PatientClientId', { value: auth.patient.client.userPoolClientId });
  }
}
