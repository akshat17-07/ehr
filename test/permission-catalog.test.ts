import { describe, expect, it } from 'vitest';
import { isPermission, PERMISSION_GROUPS, PERMISSIONS } from '../src/permissions/catalog.js';

const DEVANAGARI = /[ऀ-ॿ]/;

describe('permission catalog', () => {
  it('has each key once, written as area.action', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('describes every permission and group in English and Hindi', () => {
    for (const p of PERMISSIONS) {
      expect(p.descriptionEn, p.key).not.toBe('');
      expect(p.descriptionHi, p.key).toMatch(DEVANAGARI);
    }
    for (const [group, text] of Object.entries(PERMISSION_GROUPS)) expect(text.hi, group).toMatch(DEVANAGARI);
  });

  it('marks exactly the Admin-only permissions (api-list.md §4, last row, and "Admin only" endpoints)', () => {
    expect(PERMISSIONS.filter((p) => p.adminOnly).map((p) => p.key).sort()).toEqual([
      'fhir.export_all', 'grant_rule.manage', 'role.promote_head_doctor', 'settings.bundles', 'settings.drugs',
      'settings.manage', 'settings.tariffs', 'user.create', 'user.deactivate', 'user.mfa_reset', 'user.update',
    ]);
  });

  it('keeps permissions the hard rules depend on', () => {
    for (const key of ['user.permissions', 'patient.merge', 'payroll.bank_file', 'approval.refund', 'breakglass.invoke', 'sensitive.view']) {
      expect(isPermission(key), key).toBe(true);
    }
  });

  it('tells known keys from unknown ones', () => {
    expect(isPermission('patient.view')).toBe(true);
    expect(isPermission('patient.delete')).toBe(false);
    expect(isPermission('stock.remove')).toBe(false); // stock can never be removed by hand
  });
});
