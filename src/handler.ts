import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { isJobEvent, runJob } from './jobs/index.js';

// Lambda entry point (see infra/constructs/api.ts). Two kinds of events arrive here:
//   - API Gateway HTTP requests → the Hono app
//   - scheduled jobs from EventBridge, `{ job: "<name>" }` → src/jobs
const http = handle(createApp());

export const handler = async (event: unknown, context: unknown) => {
  if (isJobEvent(event)) return runJob(event);
  return http(event as Parameters<typeof http>[0], context as Parameters<typeof http>[1]);
};
