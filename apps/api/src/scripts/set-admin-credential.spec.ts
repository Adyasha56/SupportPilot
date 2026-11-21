import { describe, expect, it } from 'vitest';
import { MINIMUM_PASSWORD_LENGTH, parseArgs, requireEmail, requireTenantId, resolvePassword, validatePasswordStrength, WeakPasswordError } from './set-admin-credential';

describe('parseArgs', () => {
  it('parses --key=value pairs and bare --flags', () => {
    expect(parseArgs(['--tenantId=acme', '--email=a@b.com', '--allow-test-db'])).toEqual({
      tenantId: 'acme',
      email: 'a@b.com',
      'allow-test-db': true,
    });
  });
});

describe('requireTenantId', () => {
  it('accepts a valid tenant id', () => {
    expect(requireTenantId({ tenantId: 'acme' })).toBe('acme');
  });

  it('rejects a missing or invalid tenantId', () => {
    expect(() => requireTenantId({})).toThrow(/--tenantId is required/);
    expect(() => requireTenantId({ tenantId: 'Not Valid!' })).toThrow(/--tenantId is required/);
  });
});

describe('requireEmail', () => {
  it('accepts and normalizes a valid email to lowercase', () => {
    expect(requireEmail({ email: 'Owner@ACME.example' })).toBe('owner@acme.example');
  });

  it('rejects a missing or malformed email', () => {
    expect(() => requireEmail({})).toThrow(/--email is required/);
    expect(() => requireEmail({ email: 'not-an-email' })).toThrow(/--email is required/);
  });
});

describe('validatePasswordStrength (item 1)', () => {
  it('accepts a password at or above the minimum length that is not on the denylist', () => {
    expect(() => validatePasswordStrength('a'.repeat(MINIMUM_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects a password shorter than the minimum length', () => {
    expect(() => validatePasswordStrength('a'.repeat(MINIMUM_PASSWORD_LENGTH - 1))).toThrow(WeakPasswordError);
  });

  it('rejects a password on the trivial denylist, case-insensitively, even if long enough', () => {
    expect(() => validatePasswordStrength('PASSWORD1234')).toThrow(WeakPasswordError);
  });
});

describe('resolvePassword (item 1 - never argv)', () => {
  it('refuses --password on the command line, even before checking the environment variable', async () => {
    await expect(resolvePassword({ password: 'whatever-on-argv' })).rejects.toThrow(/never accepted on the command line/);
  });

  it('uses ADMIN_CREDENTIAL_PASSWORD when set and no --password flag is present', async () => {
    const prior = process.env.ADMIN_CREDENTIAL_PASSWORD;
    process.env.ADMIN_CREDENTIAL_PASSWORD = 'from-the-environment-123';
    try {
      expect(await resolvePassword({})).toBe('from-the-environment-123');
    } finally {
      if (prior === undefined) {
        delete process.env.ADMIN_CREDENTIAL_PASSWORD;
      } else {
        process.env.ADMIN_CREDENTIAL_PASSWORD = prior;
      }
    }
  });
});
