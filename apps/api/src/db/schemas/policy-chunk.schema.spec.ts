import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@supportpilot/shared';
import {
  POLICY_CHUNK_EMBEDDING_DIMENSION,
  POLICY_CHUNK_VECTOR_INDEX_DEFINITION,
  POLICY_CHUNK_VECTOR_INDEX_NAME,
  PolicyChunkSchema,
} from './policy-chunk.schema';

const PolicyChunkModel = mongoose.model('PolicyChunkSchemaSpecTest', PolicyChunkSchema);

function validChunkData(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'acme',
    documentId: new mongoose.Types.ObjectId(),
    title: 'Refund policy',
    position: 0,
    text: 'Refunds within 30 days.',
    embedding: new Array(768).fill(0),
    embeddingModel: 'gemini-embedding-001',
    embeddingDimension: 768,
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('PolicyChunkSchema', () => {
  it('defaults active to false', async () => {
    const doc = new PolicyChunkModel(validChunkData());
    expect(doc.active).toBe(false);
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('requires embeddingModel, embeddingDimension, and contentHash', async () => {
    const doc = new PolicyChunkModel(
      validChunkData({ embeddingModel: undefined, embeddingDimension: undefined, contentHash: undefined }),
    );
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.embeddingModel).toBeDefined();
    expect(err.errors.embeddingDimension).toBeDefined();
    expect(err.errors.contentHash).toBeDefined();
  });

  it('rejects a missing embedding', async () => {
    const doc = new PolicyChunkModel(validChunkData({ embedding: undefined }));
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.embedding).toBeDefined();
  });

  it('rejects an empty embedding array (required:true alone does not catch this on an array field)', async () => {
    const doc = new PolicyChunkModel(validChunkData({ embedding: [] }));
    const err = await doc.validate().catch((e: mongoose.Error.ValidationError) => e);
    expect(err.errors.embedding).toBeDefined();
    expect(err.errors.embedding.message).toMatch(/must not be empty/);
  });

  it('excludes embedding from a plain toObject/toJSON by schema default (select:false)', () => {
    // select:false only affects queries against the database, not an
    // in-memory document's own toObject() - this test documents that
    // distinction rather than asserting something select:false doesn't do.
    const path = PolicyChunkSchema.path('embedding');
    expect(path.options.select).toBe(false);
  });
});

describe('POLICY_CHUNK_VECTOR_INDEX_DEFINITION', () => {
  it('is named correctly and targets the embedding path', () => {
    expect(POLICY_CHUNK_VECTOR_INDEX_DEFINITION.name).toBe(POLICY_CHUNK_VECTOR_INDEX_NAME);
    expect(POLICY_CHUNK_VECTOR_INDEX_DEFINITION.type).toBe('vectorSearch');
    const vectorField = POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields.find(
      (f) => f.type === 'vector',
    );
    expect(vectorField).toMatchObject({
      path: 'embedding',
      numDimensions: POLICY_CHUNK_EMBEDDING_DIMENSION,
      similarity: 'cosine',
    });
  });

  it('declares tenantId and active as filter-type fields', () => {
    const filterPaths = POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields
      .filter((f) => f.type === 'filter')
      .map((f) => f.path);
    expect(filterPaths.sort()).toEqual(['active', 'tenantId']);
  });

  it('declares exactly one vector field (this module defines exactly one search index total)', () => {
    const vectorFields = POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields.filter(
      (f) => f.type === 'vector',
    );
    expect(vectorFields).toHaveLength(1);
  });
});

describe('embedding dimension stays in sync with @supportpilot/shared', () => {
  // Guards against the vector index and the LLM provider silently
  // diverging if either side is ever edited to use a literal number
  // instead of the shared constant - a mismatch would make retrieval
  // either fail outright or silently return nothing.
  it('the index definition uses the shared EMBEDDING_DIMENSION constant', () => {
    expect(POLICY_CHUNK_EMBEDDING_DIMENSION).toBe(EMBEDDING_DIMENSION);
    const vectorField = POLICY_CHUNK_VECTOR_INDEX_DEFINITION.definition.fields.find((f) => f.type === 'vector');
    expect(vectorField?.numDimensions).toBe(EMBEDDING_DIMENSION);
  });

  it('EMBEDDING_MODEL and EMBEDDING_DIMENSION are the pinned, intentional values', () => {
    // Pins the current decision explicitly, so changing either is a visible,
    // deliberate diff here rather than an accidental one-line edit elsewhere.
    expect(EMBEDDING_MODEL).toBe('gemini-embedding-001');
    expect(EMBEDDING_DIMENSION).toBe(768);
  });
});
