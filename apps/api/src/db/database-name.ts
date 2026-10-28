/**
 * The one fixed test database's name must start with this prefix. Used two
 * ways: the test suite REFUSES to run unless the database name HAS this
 * prefix (so a test run can never accidentally point at a real database);
 * scripts REFUSE to run if the database name HAS this prefix, unless an
 * explicit flag overrides it (so a script can never accidentally run
 * against the shared test database and churn its data/index state).
 */
export const TEST_DATABASE_PREFIX = 'test_';

/**
 * Extracts the database name from a MongoDB connection string's path.
 *
 * Limitation (documented, not hidden): uses the standard WHATWG URL parser,
 * which only supports a single host - this works for mongodb+srv:// (the
 * standard modern Atlas format, DNS-SRV based with one hostname) and a
 * single-host mongodb:// URI (e.g. Atlas Local), but NOT a legacy
 * comma-separated multi-host mongodb://host1,host2,host3/db replica set
 * string. If we ever need that form, this needs a real connection-string
 * parser instead.
 */
export function getDatabaseNameFromUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(
      'Could not parse MONGODB_URI as a URL. This parser supports mongodb+srv:// and ' +
        'single-host mongodb:// only, not a comma-separated multi-host connection string.',
    );
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error('MONGODB_URI must include a database name in its path (e.g. ".../mydb").');
  }
  return name;
}

/**
 * Throws unless the database name is safe for a script to run against:
 * i.e. it does NOT look like the shared test database, unless explicitly
 * allowed via allowTestDb.
 */
export function assertNotTestDatabase(uri: string, allowTestDb: boolean): void {
  const name = getDatabaseNameFromUri(uri);
  if (name.startsWith(TEST_DATABASE_PREFIX) && !allowTestDb) {
    throw new Error(
      `Refusing to run against database "${name}", which looks like the shared test database ` +
        `(starts with "${TEST_DATABASE_PREFIX}"). Pass --allow-test-db if this is intentional.`,
    );
  }
}
