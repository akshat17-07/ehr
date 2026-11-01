import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as triggers from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import { backendFunction } from './backend-function.js';
import type { Database } from './database.js';

export interface MigrationsProps {
  database: Database;
  /** The API Lambda's role; migration 0001 lets it log in as ehr_app. */
  apiRole: iam.IRole;
}

/**
 * Runs backend/src/db/migrations.ts during every deploy that changes them (CDK Trigger), before the deploy finishes.
 * This is the only function allowed to log in as the DSQL admin. A failed migration fails the deploy.
 */
export class Migrations extends Construct {
  constructor(scope: Construct, id: string, props: MigrationsProps) {
    super(scope, id);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dsql:DbConnectAdmin'],
        resources: [props.database.cluster.attrResourceArn],
      }),
    );

    const fn = backendFunction(this, 'Function', {
      entry: 'migrate.ts',
      role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        DSQL_ENDPOINT: props.database.endpoint,
        DB_USER: 'admin',
        API_ROLE_ARN: props.apiRole.roleArn,
      },
    });

    new triggers.Trigger(this, 'RunOnDeploy', {
      handler: fn,
      executeOnHandlerChange: true,
      executeAfter: [props.database.cluster],
      timeout: Duration.minutes(5),
    });
  }
}
