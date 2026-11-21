/**
 * Milestone 5, Stage 1b, item 6 - `Approval.decidedBy`'s format. Through
 * Milestone 4, every caller passed a bare id (an ApiKey document's own id,
 * e.g. `"507f1f77bcf86cd799439011"`, or the literal `'system:auto_execute'`
 * a few call sites already used informally). Going forward, every NEW
 * write uses one of the three prefixed forms below, naming WHICH KIND of
 * principal decided - a plain id alone can't tell an admin API key apart
 * from an admin console session, or either from the unattended
 * auto-execute path. `Approval.decidedBy`'s own Zod schema
 * (`ApprovalRecordSchema`, approval-schemas.ts) stays a bare
 * `z.string().optional()` - deliberately NOT tightened to only accept
 * these three forms - specifically so a pre-existing document written
 * before this change keeps validating and keeps displaying (as `legacy`,
 * below) rather than failing to parse.
 */
export type DecidedByKind = 'api_key' | 'admin_session' | 'system_auto_execute' | 'legacy';

export interface ParsedDecidedBy {
  kind: DecidedByKind;
  /** The id half, when this value names one - absent for `system_auto_execute`. */
  id?: string;
}

export const SYSTEM_AUTO_EXECUTE_DECIDED_BY = 'system:auto_execute';

export function decidedByForApiKey(apiKeyId: string): string {
  return `key:${apiKeyId}`;
}

export function decidedByForAdminSession(credentialId: string): string {
  return `admin:${credentialId}`;
}

/**
 * Never throws - a value this project itself never wrote (anything not
 * matching one of the three known prefixes, including every pre-Stage-1b
 * document) is `legacy`, with the ENTIRE original string preserved as
 * `id` so display code can still show something meaningful rather than
 * discarding it.
 */
export function parseDecidedBy(value: string | null | undefined): ParsedDecidedBy | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value === SYSTEM_AUTO_EXECUTE_DECIDED_BY) {
    return { kind: 'system_auto_execute' };
  }
  if (value.startsWith('key:') && value.length > 'key:'.length) {
    return { kind: 'api_key', id: value.slice('key:'.length) };
  }
  if (value.startsWith('admin:') && value.length > 'admin:'.length) {
    return { kind: 'admin_session', id: value.slice('admin:'.length) };
  }
  return { kind: 'legacy', id: value };
}

/** A short, human-readable label for an admin console (not yet built) to show - never the raw value verbatim for the legacy case's own sake, but never hidden either. */
export function describeDecidedBy(value: string | null | undefined): string | undefined {
  const parsed = parseDecidedBy(value);
  if (!parsed) {
    return undefined;
  }
  switch (parsed.kind) {
    case 'api_key':
      return `API key (${parsed.id})`;
    case 'admin_session':
      return `Admin console session (${parsed.id})`;
    case 'system_auto_execute':
      return 'Automatic execution';
    case 'legacy':
      return `Legacy record (${parsed.id})`;
  }
}
