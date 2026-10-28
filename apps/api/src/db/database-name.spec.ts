import { describe, expect, it } from 'vitest';
import { assertNotTestDatabase, getDatabaseNameFromUri, TEST_DATABASE_PREFIX } from './database-name';

describe('getDatabaseNameFromUri', () => {
  it('extracts the database name from a mongodb+srv:// URI', () => {
    expect(
      getDatabaseNameFromUri('mongodb+srv://user:pass@cluster0.abcde.mongodb.net/supportpilot?w=majority'),
    ).toBe('supportpilot');
  });

  it('extracts the database name from a single-host mongodb:// URI', () => {
    expect(getDatabaseNameFromUri('mongodb://127.0.0.1:27017/test_supportpilot')).toBe(
      'test_supportpilot',
    );
  });

  it('throws a clear error for a comma-separated multi-host URI (documented limitation)', () => {
    expect(() =>
      getDatabaseNameFromUri('mongodb://host1:27017,host2:27017/mydb?replicaSet=rs0'),
    ).toThrow(/Could not parse MONGODB_URI/);
  });

  it('throws when the URI has no database name in its path', () => {
    expect(() => getDatabaseNameFromUri('mongodb://127.0.0.1:27017')).toThrow(
      /must include a database name/,
    );
  });
});

describe('assertNotTestDatabase', () => {
  it('allows a non-test database name', () => {
    expect(() =>
      assertNotTestDatabase('mongodb://127.0.0.1:27017/supportpilot', false),
    ).not.toThrow();
  });

  it(`refuses a database name starting with "${TEST_DATABASE_PREFIX}" unless allowed`, () => {
    expect(() =>
      assertNotTestDatabase('mongodb://127.0.0.1:27017/test_supportpilot', false),
    ).toThrow(/Refusing to run/);
  });

  it('allows a test database name when explicitly permitted', () => {
    expect(() =>
      assertNotTestDatabase('mongodb://127.0.0.1:27017/test_supportpilot', true),
    ).not.toThrow();
  });
});
