import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

// Staff user types. Finer permission bundles (reception, billing, ...) live in the database.
export const STAFF_GROUPS = ['admin', 'head_doctor', 'doctor', 'nurse', 'staff', 'medical', 'insurance', 'gp'] as const;

export interface AuthProps {
  prod: boolean;
}

export interface UserPoolWithClient {
  pool: cognito.UserPool;
  client: cognito.UserPoolClient;
  /** Token issuer URL, used by the API Gateway JWT authorizer. */
  issuer: string;
}

/**
 * Two Cognito (Essentials) pools: staff and patients.
 * Both: no self sign-up (accounts are created by the hospital), TOTP 2FA required, no SMS.
 */
export class Auth extends Construct {
  readonly staff: UserPoolWithClient;
  readonly patient: UserPoolWithClient;

  constructor(scope: Construct, id: string, private readonly props: AuthProps) {
    super(scope, id);

    this.staff = this.createPool('Staff', 'staff');
    for (const group of STAFF_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `StaffGroup-${group}`, {
        userPoolId: this.staff.pool.userPoolId,
        groupName: group,
      });
    }

    this.patient = this.createPool('Patient', 'patient portal');
  }

  private createPool(id: string, audience: string): UserPoolWithClient {
    const pool = new cognito.UserPool(this, `${id}Pool`, {
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireSymbols: false, tempPasswordValidity: Duration.days(3) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Your hospital EHR account',
        emailBody:
          `Hello,<br><br>An account has been created for you (${audience}).<br>` +
          'Username: {username}<br>Temporary password: {####}<br><br>' +
          'At first sign-in you will choose a new password and set up an authenticator app.',
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const client = pool.addClient('Client', {
      // SRP for the website later. Password flow (still with TOTP) only outside prod, for testing the API.
      authFlows: { userSrp: true, userPassword: !this.props.prod },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
      enableTokenRevocation: true,
    });

    const region = pool.stack.region;
    return { pool, client, issuer: `https://cognito-idp.${region}.amazonaws.com/${pool.userPoolId}` };
  }
}
