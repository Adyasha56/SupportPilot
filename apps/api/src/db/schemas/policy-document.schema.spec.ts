import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { PolicyDocumentSchema } from './policy-document.schema';

const PolicyDocumentModel = mongoose.model('PolicyDocumentSchemaSpecTest', PolicyDocumentSchema);

describe('PolicyDocumentSchema', () => {
  it('defaults status to pending, chunkCount to 0, and failureCode to null', async () => {
    const doc = new PolicyDocumentModel({ tenantId: 'acme', title: 'Refund policy', contentHash: 'abc123' });
    expect(doc.status).toBe('pending');
    expect(doc.chunkCount).toBe(0);
    expect(doc.failureCode).toBeNull();
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a status outside the enum', async () => {
    const doc = new PolicyDocumentModel({ tenantId: 'acme', title: 'x', contentHash: 'abc123', status: 'archived' });
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.status).toBeDefined();
  });

  it('rejects a failureCode outside the known set', async () => {
    const doc = new PolicyDocumentModel({ tenantId: 'acme', title: 'x', contentHash: 'abc123', failureCode: 'SOMETHING_MADE_UP' });
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.failureCode).toBeDefined();
  });

  it('requires tenantId, title, and contentHash', async () => {
    const doc = new PolicyDocumentModel({});
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.tenantId).toBeDefined();
    expect(err.errors.title).toBeDefined();
    expect(err.errors.contentHash).toBeDefined();
  });
});
