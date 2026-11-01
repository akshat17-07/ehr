import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.js';
import { Api } from './constructs/api.js';
import { AuditTrail } from './constructs/audit-trail.js';
import { Auth } from './constructs/auth.js';
import { Database } from './constructs/database.js';
import { Files } from './constructs/files.js';
import { FrontendDeployRole } from './constructs/frontend-deploy-role.js';
import { Jobs } from './constructs/jobs.js';
import { Migrations } from './constructs/migrations.js';
import { Monitoring } from './constructs/monitoring.js';
import { Website } from './constructs/website.js';

export interface EhrStackProps extends StackProps {
  config: StageConfig;
}

// Everything for one stage (dev / prod) in ap-south-1, in the app account.
export class EhrStack extends Stack {
  constructor(scope: Construct, id: string, props: EhrStackProps) {
    super(scope, id, props);
    const { config } = props;

    Tags.of(this).add('app', 'ehr');
    Tags.of(this).add('stage', config.stage);

    const website = new Website(this, 'Website');
    // The local dev server (`npm run dev` in frontend) may call dev, never prod.
    const allowedOrigins = config.prod ? [website.url] : [website.url, 'http://localhost:5173'];

    const database = new Database(this, 'Database');
    const files = new Files(this, 'Files', { config, allowedOrigins });
    const auth = new Auth(this, 'Auth', { prod: config.prod });
    const api = new Api(this, 'Api', { config, database, files, auth, allowedOrigins });
    new Migrations(this, 'Migrations', { database, apiRole: api.role });
    new Jobs(this, 'Jobs', { handler: api.function });
    new AuditTrail(this, 'AuditTrail');
    new Monitoring(this, 'Monitoring', { apiFunction: api.function, alertEmail: config.alertEmail });

    website.writeConfig({
      apiUrl: api.url,
      region: this.region,
      staffPoolId: auth.staff.pool.userPoolId,
      staffClientId: auth.staff.client.userPoolClientId,
      patientPoolId: auth.patient.pool.userPoolId,
      patientClientId: auth.patient.client.userPoolClientId,
    });
    const frontendDeploy = new FrontendDeployRole(this, 'FrontendDeploy', { website, repo: config.frontendRepo });

    // Values for the console and for the frontend repo's GitHub secrets.
    const outputs: Record<string, string> = {
      WebsiteUrl: website.url,
      ApiUrl: api.url,
      WebsiteBucket: website.bucket.bucketName,
      WebsiteDistributionId: website.distribution.distributionId,
      FrontendDeployRoleArn: frontendDeploy.role.roleArn,
      ApiRoleArn: api.role.roleArn,
      DsqlEndpoint: database.endpoint,
      FilesBucket: files.bucket.bucketName,
      ExportsBucket: files.exportsBucket.bucketName,
      StaffPoolId: auth.staff.pool.userPoolId,
      StaffClientId: auth.staff.client.userPoolClientId,
      PatientPoolId: auth.patient.pool.userPoolId,
      PatientClientId: auth.patient.client.userPoolClientId,
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
  }
}
