import { describe, expect, it } from 'vitest';
import { InMemoryMessageRepository } from './in-memory-message.repository';

describe('InMemoryMessageRepository', () => {
  it('creates a message and returns it with the given role and content', async () => {
    const repo = new InMemoryMessageRepository();
    const message = await repo.create('acme', 'conv_1', 'customer', 'where is my order');
    expect(message.role).toBe('customer');
    expect(message.content).toBe('where is my order');
    expect(message.tenantId).toBe('acme');
    expect(message.conversationId).toBe('conv_1');
  });

  it('findRecentForConversation returns messages oldest-first, scoped by tenant and conversation', async () => {
    const repo = new InMemoryMessageRepository();
    await repo.create('acme', 'conv_1', 'customer', 'first');
    await repo.create('acme', 'conv_1', 'agent', 'second');
    await repo.create('acme', 'conv_2', 'customer', 'different conversation');
    await repo.create('widgetco', 'conv_1', 'customer', 'different tenant, same conversation id');

    const results = await repo.findRecentForConversation('acme', 'conv_1', 10);

    expect(results.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('findRecentForConversation respects the limit, keeping only the most recent messages', async () => {
    const repo = new InMemoryMessageRepository();
    for (let i = 1; i <= 5; i++) {
      await repo.create('acme', 'conv_1', 'customer', `msg${i}`);
    }

    const results = await repo.findRecentForConversation('acme', 'conv_1', 2);

    expect(results.map((m) => m.content)).toEqual(['msg4', 'msg5']);
  });

  it('deleteForTenant only removes that tenant\'s messages', async () => {
    const repo = new InMemoryMessageRepository();
    await repo.create('acme', 'conv_1', 'customer', 'acme message');
    await repo.create('widgetco', 'conv_1', 'customer', 'widgetco message');

    await repo.deleteForTenant('acme');

    expect(await repo.findRecentForConversation('acme', 'conv_1', 10)).toEqual([]);
    expect(await repo.findRecentForConversation('widgetco', 'conv_1', 10)).toHaveLength(1);
  });
});
