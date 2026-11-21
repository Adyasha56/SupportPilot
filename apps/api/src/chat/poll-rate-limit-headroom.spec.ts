import { describe, expect, it } from 'vitest';
import { loadChatSettingsFromEnv } from './chat.settings';
import {
  ASSUMED_CONCURRENT_VISITORS,
  DOCUMENTED_POLL_CADENCE,
  maxRequestsInWindow,
  maxRequestsInWindowForConcurrentVisitors,
  pollRequestTimestamps,
} from './poll-rate-limit-headroom';

/**
 * Part 0, item P1 - rewritten after the Stage 1a audit found the ORIGINAL
 * version of this file proved the wrong thing: it checked polling's worst
 * case against chat's SHARED per-IP/per-key guard buckets, which is
 * exactly the design this fix removes (polling now has its own, entirely
 * separate guard instance - poll-api-key-guard.ts). What this file proves
 * now: (1) a single visitor's own worst case against the per-conversation
 * bucket, and (2) `ASSUMED_CONCURRENT_VISITORS` independent visitors'
 * worst case against every bucket that IS shared across visitors (the new
 * per-tenant poll bucket, and the poll-dedicated guard's own per-IP/per-key
 * buckets) - all against the REAL `ChatSettings` defaults, never an
 * overridden test value.
 */
describe('poll-rate-limit-headroom (Part 0 item P1 - every poll bucket, single-visitor and multi-visitor)', () => {
  const timestamps = pollRequestTimestamps(DOCUMENTED_POLL_CADENCE);

  it('produces the documented worst case: 44 requests over the full 10-minute policy, for ONE visitor', () => {
    expect(timestamps).toHaveLength(44);
  });

  it('a single visitor\'s busiest 60s window is 8 requests', () => {
    expect(maxRequestsInWindow(timestamps, 60_000)).toBe(8);
  });

  it('the per-conversation bucket (one visitor\'s own stream) comfortably covers the full single-visitor worst case', () => {
    const settings = loadChatSettingsFromEnv({});
    expect(timestamps.length).toBeLessThanOrEqual(settings.pollRateLimitMaxRequests);
  });

  describe(`${ASSUMED_CONCURRENT_VISITORS} concurrent visitors (the stated assumption every shared bucket below is sized against)`, () => {
    it('worst case in any 60s window is 160 requests (8 per visitor x 20, assuming perfect phase alignment - the documented pessimistic assumption)', () => {
      expect(maxRequestsInWindowForConcurrentVisitors(timestamps, 60_000, ASSUMED_CONCURRENT_VISITORS)).toBe(160);
    });

    it('leaves real headroom under the REAL per-TENANT poll bucket default', () => {
      const settings = loadChatSettingsFromEnv({});
      const worstCase = maxRequestsInWindowForConcurrentVisitors(timestamps, settings.pollTenantRateLimitWindowMs, ASSUMED_CONCURRENT_VISITORS);
      expect(worstCase).toBeLessThanOrEqual(settings.pollTenantRateLimitMaxRequests);
    });

    it('leaves real headroom under the poll-dedicated guard\'s per-IP bucket default (e.g. all 20 visitors behind one NAT)', () => {
      const settings = loadChatSettingsFromEnv({});
      const worstCase = maxRequestsInWindowForConcurrentVisitors(timestamps, settings.pollGuardIpRateLimitWindowMs, ASSUMED_CONCURRENT_VISITORS);
      expect(worstCase).toBeLessThanOrEqual(settings.pollGuardIpRateLimitMaxRequests);
    });

    it('leaves real headroom under the poll-dedicated guard\'s per-API-key bucket default (every visitor shares the tenant\'s one public key)', () => {
      const settings = loadChatSettingsFromEnv({});
      const worstCase = maxRequestsInWindowForConcurrentVisitors(timestamps, settings.pollGuardApiKeyRateLimitWindowMs, ASSUMED_CONCURRENT_VISITORS);
      expect(worstCase).toBeLessThanOrEqual(settings.pollGuardApiKeyRateLimitMaxRequests);
    });
  });

  it('polling no longer touches chat\'s OWN per-IP/per-key guard limits at all - they stay at their chat-sized defaults, untouched by this file\'s math', () => {
    const settings = loadChatSettingsFromEnv({});
    // A sanity check that these two settings objects are genuinely independent, not a
    // regression back to Stage 1a's shared-instance design: the poll guard defaults are
    // deliberately much larger than chat's own (polling is high-frequency by nature; chat
    // sends are not), which would have been a nonsensical, overly-permissive value for
    // chat's own per-IP/per-key buckets to carry.
    expect(settings.pollGuardIpRateLimitMaxRequests).toBeGreaterThan(settings.rateLimitIpMaxRequests);
    expect(settings.pollGuardApiKeyRateLimitMaxRequests).toBeGreaterThan(settings.rateLimitApiKeyMaxRequests);
  });
});
