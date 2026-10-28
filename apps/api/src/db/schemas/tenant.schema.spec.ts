import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { TenantSchema } from './tenant.schema';

// Registering a model is purely in-memory metadata - no DB connection needed
// to run schema-level validation via validate(). (validateSync() is
// deprecated as of Mongoose 9, removed in 10 - confirmed directly.)
const TenantModel = mongoose.model('TenantSchemaSpecTest', TenantSchema);

describe('TenantSchema', () => {
  it('accepts a valid tenant id', async () => {
    const doc = new TenantModel({ _id: 'acme', name: 'Acme Inc' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a tenant id that does not match the shared slug pattern', async () => {
    const doc = new TenantModel({ _id: 'Acme!', name: 'Acme Inc' });
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors._id).toBeDefined();
  });

  it('requires a name', async () => {
    const doc = new TenantModel({ _id: 'acme' });
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.name).toBeDefined();
  });
});
