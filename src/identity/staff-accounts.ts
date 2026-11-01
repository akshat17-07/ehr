import { requireEnv } from '../config/env.js';

// Sign-in accounts of staff in the Cognito staff pool. The pool signs in by email, so the email is the username.
// Accounts are never deleted: they are disabled (#158) and can be enabled again (#159).

export interface StaffAccounts {
  /** Creates the account; Cognito emails a temporary password. Returns the new user's sub. 409 if the email is taken. */
  invite(user: { email: string; name: string }): Promise<string>;
  addToGroup(email: string, group: string): Promise<void>;
  disable(email: string): Promise<void>;
}

async function client() {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider');
  return { sdk, cognito: new sdk.CognitoIdentityProviderClient({}), UserPoolId: requireEnv('STAFF_POOL_ID') };
}

export const cognitoStaffAccounts: StaffAccounts = {
  async invite({ email, name }) {
    const { sdk, cognito, UserPoolId } = await client();
    const { User } = await cognito.send(
      new sdk.AdminCreateUserCommand({
        UserPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: name },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    const sub = User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error('Cognito returned no sub for the new user');
    return sub;
  },
  async addToGroup(email, group) {
    const { sdk, cognito, UserPoolId } = await client();
    await cognito.send(new sdk.AdminAddUserToGroupCommand({ UserPoolId, Username: email, GroupName: group }));
  },
  async disable(email) {
    const { sdk, cognito, UserPoolId } = await client();
    await cognito.send(new sdk.AdminDisableUserCommand({ UserPoolId, Username: email }));
  },
};

/** True for Cognito's "this username already exists" error. */
export const isUsernameTaken = (error: unknown) => (error as { name?: string })?.name === 'UsernameExistsException';
