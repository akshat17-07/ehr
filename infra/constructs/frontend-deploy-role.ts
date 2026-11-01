import { Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { Website } from './website.js';

export interface FrontendDeployRoleProps {
  website: Website;
  /** `owner/name` of the frontend GitHub repo. Only its main branch can use the role. */
  repo: string;
}

/**
 * Role for the frontend repo's GitHub Actions (OIDC, no stored keys).
 * It can upload the website and clear the CloudFront cache. Nothing else: no patient data, no config.json.
 * Uses the GitHub OIDC provider that already exists in the account (made in the console for backend deploys).
 */
export class FrontendDeployRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: FrontendDeployRoleProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHub',
      stack.formatArn({ service: 'iam', region: '', resource: 'oidc-provider', resourceName: 'token.actions.githubusercontent.com' }),
    );

    this.role = new iam.Role(this, 'Role', {
      description: `Website upload from ${props.repo} (main branch)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:ref:refs/heads/main`,
        },
      }),
    });

    const { bucket, distribution } = props.website;
    bucket.grantRead(this.role);
    bucket.grantPut(this.role);
    // config.json belongs to the backend deploy.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('config.json')],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [stack.formatArn({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: distribution.distributionId })],
      }),
    );
  }
}
