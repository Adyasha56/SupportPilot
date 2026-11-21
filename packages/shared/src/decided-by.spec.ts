import { describe, expect, it } from 'vitest';
import { decidedByForAdminSession, decidedByForApiKey, describeDecidedBy, parseDecidedBy, SYSTEM_AUTO_EXECUTE_DECIDED_BY } from './decided-by';

describe('decided-by', () => {
  it('formats and parses an API key principal', () => {
    const value = decidedByForApiKey('key_123');
    expect(value).toBe('key:key_123');
    expect(parseDecidedBy(value)).toEqual({ kind: 'api_key', id: 'key_123' });
  });

  it('formats and parses an admin session principal', () => {
    const value = decidedByForAdminSession('acme');
    expect(value).toBe('admin:acme');
    expect(parseDecidedBy(value)).toEqual({ kind: 'admin_session', id: 'acme' });
  });

  it('parses the fixed system auto-execute marker', () => {
    expect(parseDecidedBy(SYSTEM_AUTO_EXECUTE_DECIDED_BY)).toEqual({ kind: 'system_auto_execute' });
  });

  it('a pre-Stage-1b bare id (an old document) parses as legacy, preserving the original value, never throwing', () => {
    expect(parseDecidedBy('507f1f77bcf86cd799439011')).toEqual({ kind: 'legacy', id: '507f1f77bcf86cd799439011' });
    expect(parseDecidedBy('key_1')).toEqual({ kind: 'legacy', id: 'key_1' });
  });

  it('returns undefined for null/undefined, never throws', () => {
    expect(parseDecidedBy(null)).toBeUndefined();
    expect(parseDecidedBy(undefined)).toBeUndefined();
  });

  it('describeDecidedBy gives a distinct label per kind, including legacy', () => {
    expect(describeDecidedBy(decidedByForApiKey('k1'))).toBe('API key (k1)');
    expect(describeDecidedBy(decidedByForAdminSession('acme'))).toBe('Admin console session (acme)');
    expect(describeDecidedBy(SYSTEM_AUTO_EXECUTE_DECIDED_BY)).toBe('Automatic execution');
    expect(describeDecidedBy('legacy-raw-id')).toBe('Legacy record (legacy-raw-id)');
    expect(describeDecidedBy(null)).toBeUndefined();
  });
});
