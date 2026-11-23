import { describe, expect, it } from 'vitest';
import { GENERIC_ID_PATTERN } from '@supportpilot/shared';
import { InMemoryConversationRepository } from './in-memory-conversation.repository';

describe('InMemoryConversationRepository', () => {
  it('creates an open conversation with messageCount 0 and an unguessable id matching the shared id shape', async () => {
    const repo = new InMemoryConversationRepository();
    const convo = await repo.create('acme', 'cust_1');

    expect(convo.status).toBe('open');
    expect(convo.messageCount).toBe(0);
    expect(convo.customerRef).toBe('cust_1');
    expect(GENERIC_ID_PATTERN.test(convo.id)).toBe(true);
  });

  it('allows a null customerRef for an anonymous conversation', async () => {
    const repo = new InMemoryConversationRepository();
    const convo = await repo.create('acme', null);
    expect(convo.customerRef).toBeNull();
  });

  it("findById returns null for another tenant's conversation", async () => {
    const repo = new InMemoryConversationRepository();
    const convo = await repo.create('acme', 'cust_1');
    expect(await repo.findById('widgetco', convo.id)).toBeNull();
    expect(await repo.findById('acme', convo.id)).toMatchObject({ id: convo.id });
  });

  it('incrementMessageCount is scoped by tenantId and returns the new total', async () => {
    const repo = new InMemoryConversationRepository();
    const convo = await repo.create('acme', 'cust_1');

    expect(await repo.incrementMessageCount('widgetco', convo.id, 1)).toBe(0); // wrong tenant - no-op
    expect(await repo.incrementMessageCount('acme', convo.id, 1)).toBe(1);
    expect(await repo.incrementMessageCount('acme', convo.id, 1)).toBe(2);
    expect((await repo.findById('acme', convo.id))?.messageCount).toBe(2);
  });

  it('deleteForTenant only removes that tenant\'s conversations', async () => {
    const repo = new InMemoryConversationRepository();
    const acme = await repo.create('acme', 'cust_1');
    const widgetco = await repo.create('widgetco', 'cust_1');

    await repo.deleteForTenant('acme');

    expect(await repo.findById('acme', acme.id)).toBeNull();
    expect(await repo.findById('widgetco', widgetco.id)).toMatchObject({ id: widgetco.id });
  });

  describe('Stage 1c, item 2 - list (the admin console conversation list)', () => {
    it('is scoped by tenant and sorted newest-first', async () => {
      const repo = new InMemoryConversationRepository();
      const a = await repo.create('acme', 'cust_1');
      await new Promise((r) => setTimeout(r, 2));
      const b = await repo.create('acme', 'cust_2');
      await repo.create('widgetco', 'cust_1');

      const result = await repo.list('acme', {});
      expect(result.conversations.map((c) => c.id)).toEqual([b.id, a.id]);
    });

    it('filters by status', async () => {
      const repo = new InMemoryConversationRepository();
      const open = await repo.create('acme', 'cust_1');
      const toClose = await repo.create('acme', 'cust_2');
      (toClose as { status: 'open' | 'closed' }).status = 'closed';

      const result = await repo.list('acme', { status: 'closed' });
      expect(result.conversations.map((c) => c.id)).toEqual([toClose.id]);
      expect(result.conversations.map((c) => c.id)).not.toContain(open.id);
    });

    it('filters by createdAfter/createdBefore', async () => {
      const repo = new InMemoryConversationRepository();
      const early = await repo.create('acme', 'cust_1');
      early.createdAt = new Date('2026-01-01T00:00:00.000Z');
      const late = await repo.create('acme', 'cust_2');
      late.createdAt = new Date('2026-06-01T00:00:00.000Z');

      const result = await repo.list('acme', { createdAfter: new Date('2026-03-01T00:00:00.000Z') });
      expect(result.conversations.map((c) => c.id)).toEqual([late.id]);
    });

    it('paginates via cursor with a stable tiebreaker, never skipping or repeating a row', async () => {
      const repo = new InMemoryConversationRepository();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const c = await repo.create('acme', `cust_${i}`);
        ids.push(c.id);
        await new Promise((r) => setTimeout(r, 2));
      }

      const firstPage = await repo.list('acme', { limit: 2 });
      expect(firstPage.conversations).toHaveLength(2);
      expect(firstPage.nextCursor).toBeDefined();

      const secondPage = await repo.list('acme', { limit: 2, cursor: firstPage.nextCursor });
      expect(secondPage.conversations).toHaveLength(2);

      const thirdPage = await repo.list('acme', { limit: 2, cursor: secondPage.nextCursor });
      expect(thirdPage.conversations).toHaveLength(1);
      expect(thirdPage.nextCursor).toBeUndefined();

      const allSeenIds = [...firstPage.conversations, ...secondPage.conversations, ...thirdPage.conversations].map((c) => c.id);
      expect(new Set(allSeenIds).size).toBe(5); // no duplicates
      expect([...allSeenIds].sort()).toEqual([...ids].sort()); // nothing skipped
    });

    it('clamps limit to MAX_CONVERSATION_LIST_LIMIT rather than rejecting it', async () => {
      const repo = new InMemoryConversationRepository();
      await repo.create('acme', 'cust_1');
      const result = await repo.list('acme', { limit: 99999 });
      expect(result.conversations).toHaveLength(1);
    });
  });
});
