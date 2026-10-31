import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ChatRequestSchema,
  ChatResultSchema,
  ComposeOutputSchema,
  PlannerOutputSchema,
  PlannerToolRequestSchema,
  ProposedActionSchema,
} from '../src/agent-schemas';
import { unsupportedGeminiKeywords } from '../src/gemini-json-schema';

describe('PlannerToolRequestSchema', () => {
  it('accepts a get_order request', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'get_order', order_id: 'ORD-1001' }).success).toBe(true);
  });

  it('accepts a track_shipment request', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'track_shipment', order_id: 'ORD-1001' }).success).toBe(true);
  });

  it('rejects issue_refund - the planner can never request a high-risk tool', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'issue_refund', order_id: 'ORD-1001', amount: 10 }).success).toBe(false);
  });

  it('rejects escalate_to_human - not a tool the planner requests, it is a code-driven outcome', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'escalate_to_human', summary: 'x' }).success).toBe(false);
  });

  it('rejects a free-form args field - every tool has explicit typed fields only', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'get_order', args: { order_id: 'ORD-1001' } }).success).toBe(false);
  });

  it('rejects an unknown extra field on a known tool', () => {
    expect(PlannerToolRequestSchema.safeParse({ tool: 'get_order', order_id: 'ORD-1001', extra: 'nope' }).success).toBe(false);
  });
});

describe('PlannerOutputSchema', () => {
  function base(overrides: Partial<Record<string, unknown>> = {}) {
    return { reasoning: 'checking the order', needsPolicy: false, toolRequests: [], ...overrides };
  }

  it('accepts a minimal valid output with needsPolicy false and no searchQuery', () => {
    expect(PlannerOutputSchema.safeParse(base()).success).toBe(true);
  });

  it('accepts needsPolicy true with a searchQuery', () => {
    expect(PlannerOutputSchema.safeParse(base({ needsPolicy: true, searchQuery: 'refund window' })).success).toBe(true);
  });

  it('rejects needsPolicy true with no searchQuery', () => {
    const result = PlannerOutputSchema.safeParse(base({ needsPolicy: true }));
    expect(result.success).toBe(false);
  });

  it('rejects needsPolicy true with an empty-string searchQuery', () => {
    const result = PlannerOutputSchema.safeParse(base({ needsPolicy: true, searchQuery: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects more than MAX_PLANNER_TOOL_REQUESTS tool requests', () => {
    const toolRequests = [
      { tool: 'get_order', order_id: 'ORD-1001' },
      { tool: 'get_order', order_id: 'ORD-1002' },
      { tool: 'get_order', order_id: 'ORD-1003' },
      { tool: 'get_order', order_id: 'ORD-1004' },
    ];
    expect(PlannerOutputSchema.safeParse(base({ toolRequests })).success).toBe(false);
  });

  it('rejects reasoning longer than 300 characters', () => {
    expect(PlannerOutputSchema.safeParse(base({ reasoning: 'x'.repeat(301) })).success).toBe(false);
  });
});

describe('ComposeOutputSchema', () => {
  function base(overrides: Partial<Record<string, unknown>> = {}) {
    return { outcome: 'reply', message: 'Your order is on the way.', citedChunkKeys: [], ...overrides };
  }

  it('accepts a reply with no proposedRefund', () => {
    expect(ComposeOutputSchema.safeParse(base()).success).toBe(true);
  });

  it('accepts propose_refund with a proposedRefund', () => {
    const result = ComposeOutputSchema.safeParse(base({ outcome: 'propose_refund', proposedRefund: { order_id: 'ORD-1001', amount: 49.99 } }));
    expect(result.success).toBe(true);
  });

  it('rejects propose_refund with no proposedRefund', () => {
    expect(ComposeOutputSchema.safeParse(base({ outcome: 'propose_refund' })).success).toBe(false);
  });

  it('rejects a reply that smuggles in a proposedRefund anyway', () => {
    const result = ComposeOutputSchema.safeParse(base({ proposedRefund: { order_id: 'ORD-1001', amount: 49.99 } }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-money amount (more than two decimals)', () => {
    const result = ComposeOutputSchema.safeParse(base({ outcome: 'propose_refund', proposedRefund: { order_id: 'ORD-1001', amount: 49.999 } }));
    expect(result.success).toBe(false);
  });

  it('rejects an outcome the model should never be able to produce (pending_approval)', () => {
    expect(ComposeOutputSchema.safeParse(base({ outcome: 'pending_approval' })).success).toBe(false);
  });

  it('rejects more than MAX_CITED_CHUNK_KEYS citations', () => {
    const citedChunkKeys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(ComposeOutputSchema.safeParse(base({ citedChunkKeys })).success).toBe(false);
  });
});

describe('ChatRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    expect(ChatRequestSchema.safeParse({ message: 'where is my order' }).success).toBe(true);
  });

  it('rejects an empty message', () => {
    expect(ChatRequestSchema.safeParse({ message: '' }).success).toBe(false);
  });

  it('rejects a message over the max length', () => {
    expect(ChatRequestSchema.safeParse({ message: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('accepts an optional customerToken and customerRef', () => {
    const result = ChatRequestSchema.safeParse({ message: 'hi', customerToken: 'abc.def', customerRef: 'cust_1' });
    expect(result.success).toBe(true);
  });
});

describe('ChatResultSchema and ProposedActionSchema', () => {
  it('accepts a reply result with citations', () => {
    const result = ChatResultSchema.safeParse({
      conversationId: 'c1',
      runId: 'r1',
      outcome: 'reply',
      message: 'done',
      citations: [{ chunkKey: 'k1', documentTitle: 'Refund Policy', headingPath: 'Refunds' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a pending_approval result with a proposedAction', () => {
    const result = ChatResultSchema.safeParse({
      conversationId: 'c1',
      runId: 'r1',
      outcome: 'pending_approval',
      message: 'pending',
      citations: [],
      proposedAction: {
        tool: 'issue_refund',
        args: { order_id: 'ORD-1001', amount: 49.99 },
        reasonCitations: ['k1'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a proposedAction whose args fail the real issue_refund input schema', () => {
    const result = ProposedActionSchema.safeParse({
      tool: 'issue_refund',
      args: { order_id: 'ORD-1001', amount: -5 },
      reasonCitations: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('Gemini responseJsonSchema compatibility', () => {
  it.each([
    ['PlannerOutputSchema', PlannerOutputSchema],
    ['ComposeOutputSchema', ComposeOutputSchema],
  ])('%s uses only Gemini-documented-supported JSON Schema keywords', (_name, schema) => {
    expect(unsupportedGeminiKeywords(schema)).toEqual([]);
  });

  it('negative control: a z.literal-based discriminant IS flagged as unsupported, proving the checker is not vacuously passing', () => {
    const literalDiscriminated = z.discriminatedUnion('tool', [
      z.object({ tool: z.literal('get_order'), order_id: z.string() }),
      z.object({ tool: z.literal('track_shipment'), order_id: z.string() }),
    ]);
    expect(unsupportedGeminiKeywords(literalDiscriminated)).toEqual(['const']);
  });
});
