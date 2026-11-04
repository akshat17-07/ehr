import { env, requireEnv } from '../config/env.js';
import type { JobEvent } from './index.js';

// Starts a job on the jobs Lambda without waiting for it (InvocationType Event). Tests pass a fake.
export type StartJob = (event: JobEvent) => Promise<void>;

export const lambdaStartJob: StartJob = async (event) => {
  const sdk = await import('@aws-sdk/client-lambda');
  const client = new sdk.LambdaClient({ region: env.AWS_REGION });
  await client.send(
    new sdk.InvokeCommand({ FunctionName: requireEnv('JOBS_FUNCTION_NAME'), InvocationType: 'Event', Payload: JSON.stringify(event) }),
  );
};
