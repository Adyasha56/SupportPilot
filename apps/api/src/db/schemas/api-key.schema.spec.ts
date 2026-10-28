import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { ApiKeySchema } from './api-key.schema';

const ApiKeyModel = mongoose.model('ApiKeySchemaSpecTest', ApiKeySchema);

function validKeyData(overrides: Record<string, unknown> = {}) {
  return { tenantId: 'acme', hash: 'abc123', keyPrefix: 'sk_abcd12', scopes: ['secret'], ...overrides };
}

describe('ApiKeySchema', () => {
  it('accepts valid scopes and defaults revokedAt to null', async () => {
    const doc = new ApiKeyModel(validKeyData());
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.revokedAt).toBeNull();
  });

  it('rejects a scope outside public/secret', async () => {
    const doc = new ApiKeyModel(validKeyData({ scopes: ['admin'] }));
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors['scopes.0']).toBeDefined();
  });

  it('requires keyPrefix', async () => {
    const doc = new ApiKeyModel(validKeyData({ keyPrefix: undefined }));
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.keyPrefix).toBeDefined();
  });

  it('hash is select:false by schema default', () => {
    const path = ApiKeySchema.path('hash');
    expect(path.options.select).toBe(false);
  });
});
