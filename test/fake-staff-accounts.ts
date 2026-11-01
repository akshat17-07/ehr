import type { StaffAccounts } from '../src/identity/staff-accounts.js';

/** Stands in for Cognito in tests: remembers accounts, groups and disabled users. */
export function fakeStaffAccounts() {
  const accounts = new Map<string, { sub: string; name: string; groups: string[]; enabled: boolean; mfaResets?: number }>();
  let next = 1;
  const fake: StaffAccounts & { accounts: typeof accounts; failAddToGroup: boolean } = {
    accounts,
    failAddToGroup: false,
    async invite({ email, name }) {
      if (accounts.has(email)) throw Object.assign(new Error('User account already exists'), { name: 'UsernameExistsException' });
      const sub = `sub-${next++}`;
      accounts.set(email, { sub, name, groups: [], enabled: true });
      return sub;
    },
    async addToGroup(email, group) {
      if (fake.failAddToGroup) throw new Error('Cognito is down');
      accounts.get(email)?.groups.push(group);
    },
    async removeFromGroup(email, group) {
      const account = accounts.get(email);
      if (account) account.groups = account.groups.filter((g) => g !== group);
    },
    async disable(email) {
      const account = accounts.get(email);
      if (account) account.enabled = false;
    },
    async enable(email) {
      const account = accounts.get(email);
      if (account) account.enabled = true;
    },
    async resetMfa(email) {
      const account = accounts.get(email);
      if (account) account.mfaResets = (account.mfaResets ?? 0) + 1;
    },
  };
  return fake;
}
