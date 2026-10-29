import { describe, expect, it } from 'vitest';
import { ATLAS_MAX_NUM_CANDIDATES, buildVectorSearchPipeline, VectorSearchParams } from './policy-chunk.repository';
import { POLICY_CHUNK_VECTOR_INDEX_NAME } from './schemas/policy-chunk.schema';

function params(overrides: Partial<VectorSearchParams> = {}): VectorSearchParams {
  return { tenantId: 'acme', queryVector: [1, 0, 0], limit: 5, ...overrides };
}

function vectorSearchStage(pipeline: ReturnType<typeof buildVectorSearchPipeline>) {
  const stage = pipeline[0] as { $vectorSearch: Record<string, unknown> };
  return stage.$vectorSearch;
}

describe('buildVectorSearchPipeline', () => {
  it('pre-filters by tenantId AND active:true, with tenantId taken only from the params argument', () => {
    const pipeline = buildVectorSearchPipeline(params({ tenantId: 'widgetco' }));
    const stage = vectorSearchStage(pipeline);

    expect(stage.filter).toEqual({ tenantId: 'widgetco', active: true });
  });

  it('fails if the pre-filter is missing entirely', () => {
    // A regression guard, not a tautology: this directly inspects the real
    // pipeline-building function's output, so if a future edit removes the
    // filter (or moves it to a $match post-filter instead), this fails -
    // it does not just assert against a hand-written expectation that
    // could drift out of sync with the real implementation.
    const pipeline = buildVectorSearchPipeline(params());
    const stage = vectorSearchStage(pipeline);
    expect(stage.filter).toBeDefined();
    expect(stage.filter).toHaveProperty('tenantId');
    expect(stage.filter).toHaveProperty('active', true);
  });

  it('never includes embedding in the $project stage', () => {
    const pipeline = buildVectorSearchPipeline(params());
    const project = (pipeline[1] as { $project: Record<string, unknown> }).$project;
    expect(project).not.toHaveProperty('embedding');
  });

  it('projects position, headingPath, embeddingModel, and embeddingDimension for the service layer to use', () => {
    const pipeline = buildVectorSearchPipeline(params());
    const project = (pipeline[1] as { $project: Record<string, unknown> }).$project;
    expect(project).toMatchObject({ position: 1, headingPath: 1, embeddingModel: 1, embeddingDimension: 1, tenantId: 1 });
  });

  it('targets the real vector index by name', () => {
    const pipeline = buildVectorSearchPipeline(params());
    expect(vectorSearchStage(pipeline).index).toBe(POLICY_CHUNK_VECTOR_INDEX_NAME);
  });

  describe('numCandidates', () => {
    it('defaults to 20x limit', () => {
      const stage = vectorSearchStage(buildVectorSearchPipeline(params({ limit: 5 })));
      expect(stage.numCandidates).toBe(100);
    });

    it('is capped at the Atlas-documented maximum (10000), even if a caller asks for more', () => {
      const stage = vectorSearchStage(buildVectorSearchPipeline(params({ limit: 5, numCandidates: 999_999 })));
      expect(stage.numCandidates).toBe(ATLAS_MAX_NUM_CANDIDATES);
    });

    it('is omitted (and exact:true set instead) when exact search is requested', () => {
      const stage = vectorSearchStage(buildVectorSearchPipeline(params({ exact: true })));
      expect(stage.exact).toBe(true);
      expect(stage.numCandidates).toBeUndefined();
    });
  });
});
