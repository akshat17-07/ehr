import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { BackupStack } from '../backup-stack.js';
import { readConfig } from '../config.js';
import { EhrStack } from '../ehr-stack.js';

const env = { account: '111111111111', region: 'ap-south-1' };

function synth(stage: 'dev' | 'prod') {
  const app = new App({ context: { stage, backupAccountId: '222222222222' } });
  const config = readConfig(app);
  const stack = new EhrStack(app, `ehr-${stage}`, { config, env });
  const backup = new BackupStack(app, `ehr-backup-${stage}`, {
    config,
    appAccountId: env.account,
    env: { ...env, account: '222222222222' },
  });
  return { app: Template.fromStack(stack), backup: Template.fromStack(backup) };
}

// Every statement of every IAM policy in a template.
function statements(t: Template): { Effect: string; Action: string | string[]; Resource?: unknown }[] {
  return Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: never[] } } }).Properties.PolicyDocument.Statement,
  );
}
const actions = (s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

let dev: ReturnType<typeof synth>;
let prod: ReturnType<typeof synth>;
beforeAll(() => {
  dev = synth('dev');
  prod = synth('prod');
}, 120_000);

describe('app stack', () => {
  it('never lets any role delete objects, except website code', () => {
    // Allowed: CDK's helper that writes config.json into the website bucket (website code, no patient data).
    const deletes = statements(dev.app).filter(
      (s) => s.Effect === 'Allow' && actions(s).some((a) => /^s3:(\*|Delete)/.test(a)),
    );
    for (const s of deletes) expect(JSON.stringify(s.Resource)).toMatch(/^\[\{"Fn::GetAtt":\["WebsiteBucket/);
    expect(deletes).toHaveLength(1);
  });

  it('never lets a role change Object Lock retention or legal holds', () => {
    // Except CDK's own config.json helper on the website bucket (no Object Lock there, no patient data).
    for (const s of statements(dev.app).filter((x) => !/WebsiteBucket/.test(JSON.stringify(x.Resource)))) {
      expect(actions(s).filter((a) => /^s3:(\*|PutObjectRetention|PutObjectLegalHold|BypassGovernanceRetention)/.test(a))).toEqual([]);
    }
  });

  it('keeps a generated, retained field-encryption key for the API (value never in the template)', () => {
    for (const [stage, t] of [['dev', dev], ['prod', prod]] as const) {
      t.app.hasResource('AWS::SecretsManager::Secret', {
        Properties: {
          Name: `ehr-${stage}-field-key`,
          GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
        },
        DeletionPolicy: 'Retain',
      });
      expect(JSON.stringify(t.app.toJSON())).toContain('FIELD_KEY_SECRET_ARN');
      expect(JSON.stringify(t.app.toJSON())).not.toMatch(/"FIELD_KEY"/);
    }
    const reads = statements(dev.app).filter((s) => actions(s).includes('secretsmanager:GetSecretValue'));
    expect(reads).toHaveLength(1);
  });

  it('requires 2FA (TOTP, no SMS) and has no self sign-up', () => {
    dev.app.resourceCountIs('AWS::Cognito::UserPool', 2);
    dev.app.allResourcesProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('locks patient files: governance 1 day in dev, compliance 10 years in prod', () => {
    const lock = (days: number, mode: string) => ({
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Days: days, Mode: mode } } },
    });
    dev.app.hasResourceProperties('AWS::S3::Bucket', lock(1, 'GOVERNANCE'));
    prod.app.hasResourceProperties('AWS::S3::Bucket', lock(3653, 'COMPLIANCE'));
  });

  it('has the API routes, with login on everything except /health and share links', () => {
    const routes = Object.values(dev.app.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => (r as { Properties: { RouteKey: string; AuthorizationType?: string } }).Properties,
    );
    const open = routes.filter((r) => (r.AuthorizationType ?? 'NONE') === 'NONE').map((r) => r.RouteKey);
    expect(open.sort()).toEqual(['GET /health', 'POST /other/share/{proxy+}']);
    for (const prefix of ['staff', 'admin', 'other', 'patient']) {
      expect(routes.some((r) => r.RouteKey === `GET /${prefix}/{proxy+}` && r.AuthorizationType === 'JWT')).toBe(true);
    }
  });

  it('allows the local dev server in dev only', () => {
    const origins = (t: Template) =>
      JSON.stringify(t.findResources('AWS::ApiGatewayV2::Api'));
    expect(origins(dev.app)).toContain('http://localhost:5173');
    expect(origins(prod.app)).not.toContain('localhost');
  });

  it('gives the frontend repo upload rights but not config.json', () => {
    dev.app.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: Match.objectLike({
                'token.actions.githubusercontent.com:sub': 'repo:akshat17-07/ehr-frontend:ref:refs/heads/main',
              }),
            },
          }),
        ],
      },
    });
    const denies = statements(dev.app).filter((s) => s.Effect === 'Deny');
    expect(JSON.stringify(denies)).toContain('config.json');
  });

  it('switches a scheduled job on only once it is built', () => {
    dev.app.resourceCountIs('AWS::Events::Rule', 7);
    dev.app.resourcePropertiesCountIs('AWS::Events::Rule', { State: 'ENABLED' }, 7);
    dev.app.resourcePropertiesCountIs('AWS::Events::Rule', { State: 'DISABLED' }, 0);
    for (const job of ['stock_scan', 'licence_check', 'audit_export', 'backup_export', 'backup_check', 'pcpndt_monthly', 'retention_review']) {
      dev.app.hasResourceProperties('AWS::Events::Rule', { State: 'ENABLED', Targets: [{ Input: JSON.stringify({ job }) }] });
    }
  });

  it('runs jobs in their own 15 minute function; the API can start only that one', () => {
    const fns = Object.values(dev.app.findResources('AWS::Lambda::Function')).map(
      (f) => (f as { Properties: { FunctionName?: string; Timeout?: number; MemorySize?: number; Environment?: { Variables: Record<string, string> } } }).Properties,
    ).filter((f) => f.Environment?.Variables.FIELD_KEY_SECRET_ARN !== undefined);
    expect(fns).toHaveLength(2);
    const jobs = fns.find((f) => f.FunctionName === 'ehr-dev-jobs');
    const api = fns.find((f) => f.FunctionName !== 'ehr-dev-jobs');
    expect(jobs).toMatchObject({ Timeout: 900, MemorySize: 1024 });
    expect(api).toMatchObject({ Timeout: 15 });
    expect(api?.Environment?.Variables.JOBS_FUNCTION_NAME).toBe('ehr-dev-jobs');
    // Every job rule targets the jobs function, none the API function.
    const rules = Object.values(dev.app.findResources('AWS::Events::Rule')) as { Properties: { Targets: { Arn: unknown }[] } }[];
    for (const r of rules) expect(JSON.stringify(r.Properties.Targets[0]!.Arn)).toContain('JobsFunction');
    // lambda:InvokeFunction only on the jobs function.
    const invokes = statements(dev.app).filter((s) => actions(s).includes('lambda:InvokeFunction') && !JSON.stringify(s.Resource).includes('Fn::GetAtt'));
    expect(invokes).toHaveLength(1);
    expect(JSON.stringify(invokes[0]!.Resource)).toContain(':function:ehr-dev-jobs');
    expect(JSON.stringify(invokes[0]!.Resource)).not.toContain('*');
  });

  it('records account activity in every region', () => {
    dev.app.hasResourceProperties('AWS::CloudTrail::Trail', {
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
    });
  });
});

describe('backup stack', () => {
  it('denies the app account every delete', () => {
    const policy = Object.values(dev.backup.findResources('AWS::S3::BucketPolicy'))[0] as {
      Properties: { PolicyDocument: { Statement: { Sid?: string; Effect: string; Action: string[] }[] } };
    };
    const deny = policy.Properties.PolicyDocument.Statement.find((s) => s.Sid === 'AppAccountNeverDeletes');
    expect(deny?.Effect).toBe('Deny');
    expect(deny?.Action).toEqual(expect.arrayContaining(['s3:DeleteObject', 's3:DeleteObjectVersion']));
  });

  it('uses Object Lock, compliance mode in prod', () => {
    prod.backup.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ehr-prod-backup-222222222222',
      ObjectLockConfiguration: { Rule: { DefaultRetention: { Days: 3653, Mode: 'COMPLIANCE' } } },
    });
  });
});
