import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { PolicyDocumentSchema } from './policy-document.schema';

const PolicyDocumentModel = mongoose.model('PolicyDocumentSchemaSpecTest', PolicyDocumentSchema);

describe('PolicyDocumentSchema', () => {
  it('defaults status to pending and chunkCount to 0', async () => {
    const doc = new PolicyDocumentModel({ tenantId: 'acme', title: 'Refund policy' });
    expect(doc.status).toBe('pending');
    expect(doc.chunkCount).toBe(0);
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a status outside the enum', async () => {
    const doc = new PolicyDocumentModel({ tenantId: 'acme', title: 'x', status: 'archived' });
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.status).toBeDefined();
  });

  it('requires tenantId and title', async () => {
    const doc = new PolicyDocumentModel({});
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.tenantId).toBeDefined();
    expect(err.errors.title).toBeDefined();
  });
});
