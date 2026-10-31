import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface MonitoringProps {
  apiFunction: lambda.IFunction;
  /** Gets an email for every alarm. AWS first sends a "confirm subscription" email. */
  alertEmail?: string;
}

// One alarm for now: any API error in a 5-minute window emails the team.
export class Monitoring extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Alerts');
    if (props.alertEmail) this.topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

    const apiErrors = new cloudwatch.Alarm(this, 'ApiErrors', {
      alarmDescription: 'The EHR API returned an error (Lambda failure).',
      metric: props.apiFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrors.addAlarmAction(new actions.SnsAction(this.topic));
  }
}
