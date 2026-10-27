import { SECRET_REF_PATTERN } from '@supportpilot/shared';

export type SecretProvider = (secretRef: string) => string | undefined;

/**
 * Defense in depth: the connector config schema already restricts secretRef
 * to this pattern at load time, but this checks again rather than trusting
 * that every caller validated it - an unrecognized name resolves to
 * "not configured", never an arbitrary env var lookup.
 */
export const envSecretProvider: SecretProvider = (secretRef) => {
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    return undefined;
  }
  return process.env[secretRef];
};
