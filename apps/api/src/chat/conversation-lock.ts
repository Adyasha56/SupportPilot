/**
 * Per-conversation in-flight lock - same in-memory, single-process
 * reasoning as TenantIngestionLock, keyed by conversationId instead of
 * tenantId, with two things TenantIngestionLock doesn't need: a TTL (a
 * lock entry older than `ttlMs` is treated as stale and can be
 * re-acquired, defending against a crashed/killed process leaving a lock
 * held forever - TenantIngestionLock has no such guard because ingestion
 * runs are rarer and always observed directly; a chat run is on the hot
 * path and must never wedge a conversation shut permanently over a single
 * crash) and a bounded size (a flood of distinct, never-reused
 * conversation ids must not grow this Map without bound).
 *
 * `ttlMs` should be set slightly ABOVE the agent loop's own
 * AGENT_TOTAL_DEADLINE_MS (chat.settings.ts's own default reflects this) -
 * a real run should always finish (success or forced escalate) well
 * before its lock would ever be considered stale; the TTL exists purely
 * as a backstop against a crash, not as an expected code path.
 */
export interface ConversationLockSettings {
  ttlMs: number;
  maxEntries: number;
}

export type ConversationLockAcquireResult = { acquired: true; release: () => void } | { acquired: false };

export class ConversationLock {
  private readonly held = new Map<string, number>();

  constructor(
    private readonly settings: ConversationLockSettings,
    private readonly clock: () => Date,
  ) {}

  tryAcquire(conversationId: string): ConversationLockAcquireResult {
    const now = this.clock().getTime();
    const existingAcquiredAt = this.held.get(conversationId);

    if (existingAcquiredAt !== undefined && now - existingAcquiredAt < this.settings.ttlMs) {
      return { acquired: false };
    }

    // Either never held, or held but stale (TTL elapsed - a crashed caller
    // never released it) - acquiring here overwrites the stale entry.
    if (existingAcquiredAt === undefined && this.held.size >= this.settings.maxEntries) {
      const oldestKey = this.held.keys().next().value;
      if (oldestKey !== undefined) {
        this.held.delete(oldestKey);
      }
    }
    this.held.set(conversationId, now);

    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.held.delete(conversationId);
      },
    };
  }
}
