import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

// Times are UTC (EventBridge); IST = UTC + 5:30. Same names as backend/src/jobs/index.ts.
// `enabled: false` until the job is built (docs/india/todo.md tasks 500–506); turning one on is a one-line change.
const JOBS = [
  { job: 'backup_export', schedule: 'cron(30 19 * * ? *)', ist: 'nightly 01:00', enabled: false },
  { job: 'audit_export', schedule: 'cron(0 20 * * ? *)', ist: 'nightly 01:30', enabled: false },
  { job: 'stock_scan', schedule: 'cron(30 20 * * ? *)', ist: 'nightly 02:00', enabled: true },
  { job: 'licence_check', schedule: 'cron(0 21 * * ? *)', ist: 'nightly 02:30', enabled: true },
  { job: 'backup_check', schedule: 'cron(30 1 * * ? *)', ist: 'daily 07:00', enabled: false },
  { job: 'pcpndt_monthly', schedule: 'cron(30 0 3 * ? *)', ist: '3rd of the month 06:00', enabled: false },
  { job: 'retention_review', schedule: 'cron(30 21 1 * ? *)', ist: '2nd of the month 03:00', enabled: false },
] as const;

export interface JobsProps {
  /** The API Lambda; it runs a job when the event is `{ job: "<name>" }`. */
  handler: lambda.IFunction;
}

/** Scheduled jobs: one EventBridge rule per job, each invoking the API Lambda with `{ job }`. */
export class Jobs extends Construct {
  constructor(scope: Construct, id: string, props: JobsProps) {
    super(scope, id);
    for (const { job, schedule, ist, enabled } of JOBS) {
      new events.Rule(this, job, {
        description: `EHR job ${job} (${ist} IST)`,
        schedule: events.Schedule.expression(schedule),
        enabled,
        targets: [
          new targets.LambdaFunction(props.handler, {
            event: events.RuleTargetInput.fromObject({ job }),
            retryAttempts: 2,
          }),
        ],
      });
    }
  }
}
