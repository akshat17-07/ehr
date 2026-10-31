import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';

// Lambda entry point (see infra/constructs/api.ts).
export const handler = handle(createApp());
