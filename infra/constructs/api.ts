import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { names, type StageConfig } from '../config.js';
import type { Auth, UserPoolWithClient } from './auth.js';
import { backendFunction, LOG_RETENTION } from './backend-function.js';
import type { Database } from './database.js';
import type { Files } from './files.js';

export interface ApiProps {
  config: StageConfig;
  database: Database;
  files: Files;
  auth: Auth;
}

/**
 * API Gateway HTTP API → one Lambda (backend/src/handler.ts). Full endpoint list: docs/india/api-list.md
 *   GET /health                anyone
 *   ANY /staff/{proxy+}        staff pool token   (workforce groups, checked in the Lambda)
 *   ANY /admin/{proxy+}        staff pool token   (admin, head_doctor)
 *   ANY /other/{proxy+}        staff pool token   (insurance, gp)
 *   ANY /patient/{proxy+}      patient pool token
 * The same Lambda also runs the scheduled jobs (constructs/jobs.ts).
 */
export class Api extends Construct {
  readonly function: NodejsFunction;
  readonly role: iam.Role;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config } = props;

    // Fixed name, so the backup account's bucket policy can allow this role to write (and only write).
    this.role = new iam.Role(this, 'Role', {
      roleName: names.apiRole(config.stage),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    this.function = backendFunction(this, 'Function', {
      entry: 'handler.ts',
      role: this.role,
      timeout: Duration.seconds(15),
      environment: {
        STAGE: config.stage,
        DSQL_ENDPOINT: props.database.endpoint,
        DB_USER: 'ehr_app',
        STAFF_POOL_ID: props.auth.staff.pool.userPoolId,
        PATIENT_POOL_ID: props.auth.patient.pool.userPoolId,
        FILES_BUCKET: props.files.bucket.bucketName,
        EXPORTS_BUCKET: props.files.exportsBucket.bucketName,
        ...(config.backupAccountId
          ? { BACKUP_BUCKET: names.backupBucket(config.stage, config.backupAccountId) }
          : {}),
      },
    });
    props.database.grantConnect(this.role);
    props.files.grantPutAndRead(this.role);

    this.httpApi = new apigw.HttpApi(this, 'HttpApi');
    this.configureStage();

    const integration = new HttpLambdaIntegration('Lambda', this.function);
    const staffAuthorizer = jwtAuthorizer('StaffAuthorizer', props.auth.staff);
    const patientAuthorizer = jwtAuthorizer('PatientAuthorizer', props.auth.patient);
    const methods = [
      apigw.HttpMethod.GET,
      apigw.HttpMethod.POST,
      apigw.HttpMethod.PATCH,
      apigw.HttpMethod.PUT,
    ];

    this.httpApi.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration });
    for (const prefix of ['staff', 'admin', 'other']) {
      this.httpApi.addRoutes({ path: `/${prefix}/{proxy+}`, methods, integration, authorizer: staffAuthorizer });
    }
    this.httpApi.addRoutes({ path: '/patient/{proxy+}', methods, integration, authorizer: patientAuthorizer });
  }

  get url(): string {
    return this.httpApi.apiEndpoint;
  }

  // Rate limits (stop floods before they cost money) and access logs on the default stage.
  private configureStage(): void {
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const stage = this.httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        time: '$context.requestTime',
        ip: '$context.identity.sourceIp',
        method: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        user: '$context.authorizer.claims.sub',
        latencyMs: '$context.integrationLatency',
      }),
    };
  }
}

function jwtAuthorizer(id: string, users: UserPoolWithClient): HttpJwtAuthorizer {
  return new HttpJwtAuthorizer(id, users.issuer, { jwtAudience: [users.client.userPoolClientId] });
}
