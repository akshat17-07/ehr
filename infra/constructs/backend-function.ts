import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

// Paths inside the backend repo root (infra/constructs → ../..).
const backend = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// CERT-In: keep logs at least 180 days, in India. One year covers it.
export const LOG_RETENTION = logs.RetentionDays.ONE_YEAR;

export interface BackendFunctionProps {
  /** File under backend/src, e.g. `handler.ts`. */
  entry: string;
  role: iam.IRole;
  environment: Record<string, string>;
  timeout: Duration;
  memorySize?: number;
  /** A fixed name, so a policy can name the function without referring to it. */
  functionName?: string;
}

/** A Lambda built from backend/src: Node 24 on ARM, one minified ESM file, logs kept a year. */
export function backendFunction(scope: Construct, id: string, props: BackendFunctionProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: backend(`src/${props.entry}`),
    handler: 'handler',
    projectRoot: backend(''),
    depsLockFilePath: backend('package-lock.json'),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    ...(props.functionName && { functionName: props.functionName }),
    memorySize: props.memorySize ?? 512,
    timeout: props.timeout,
    role: props.role,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.RETAIN }),
    environment: { ...props.environment, NODE_OPTIONS: '--enable-source-maps' },
    bundling: {
      format: OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      // The AWS SDK is in the Lambda runtime; PGlite is the local-only database and never runs in AWS.
      externalModules: ['@aws-sdk/*', '@electric-sql/pglite'],
      // Some dependencies (pg) still call require(); give ESM output a require function.
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
}
