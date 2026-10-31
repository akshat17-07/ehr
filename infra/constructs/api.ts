import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Auth, UserPoolWithClient } from './auth.js';
import type { Database } from './database.js';
import type { Files } from './files.js';

const fromRepo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// CERT-In: keep logs at least 180 days, in India. One year covers it.
const LOG_RETENTION = logs.RetentionDays.ONE_YEAR;

export interface ApiProps {
  stage: string;
  database: Database;
  files: Files;
  auth: Auth;
}

/**
 * API Gateway HTTP API → one Lambda (src/handler.ts).
 * Routes and who may call them:
 *   GET /health        anyone
 *   ANY /api/{proxy+}    staff pool token
 *   ANY /portal/{proxy+} patient pool token
 */
export class Api extends Construct {
  readonly function: NodejsFunction;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, 'Function', {
      entry: fromRepo('src/handler.ts'),
      handler: 'handler',
      depsLockFilePath: fromRepo('package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      logGroup: new logs.LogGroup(this, 'FunctionLogs', {
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      environment: {
        STAGE: props.stage,
        DSQL_ENDPOINT: props.database.endpoint,
        DB_USER: 'ehr_app',
        STAFF_POOL_ID: props.auth.staff.pool.userPoolId,
        PATIENT_POOL_ID: props.auth.patient.pool.userPoolId,
        FILES_BUCKET: props.files.bucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // Some dependencies (pg) still call require(); give ESM output a require function.
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    props.database.grantConnect(this.function);
    props.files.grantPutAndRead(this.function);

    // No CORS yet: it is added with the website, allowing only the website's address.
    this.httpApi = new apigw.HttpApi(this, 'HttpApi');
    this.configureStage();

    const integration = new HttpLambdaIntegration('Lambda', this.function);
    this.httpApi.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration });
    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer: jwtAuthorizer('StaffAuthorizer', props.auth.staff),
    });
    this.httpApi.addRoutes({
      path: '/portal/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer: jwtAuthorizer('PatientAuthorizer', props.auth.patient),
    });
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
