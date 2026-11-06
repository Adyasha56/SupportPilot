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
});
