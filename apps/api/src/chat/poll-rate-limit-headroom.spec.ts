import { describe, expect, it } from 'vitest';
import { loadChatSettingsFromEnv } from './chat.settings';
import { DOCUMENTED_POLL_CADENCE, maxRequestsInWindow, pollRequestTimestamps } from './poll-rate-limit-headroom';

describe('poll-rate-limit-headroom (item 6: polling must never trip the shared chat guard limiters)', () => {
  const timestamps = pollRequestTimestamps(DOCUMENTED_POLL_CADENCE);

  it('produces the documented worst case: 67 requests over the full 10-minute policy', () => {
    expect(timestamps).toHaveLength(67);
  });

  it('the busiest 60s window the documented cadence can ever produce is 13 requests', () => {
    expect(maxRequestsInWindow(timestamps, 60_000)).toBe(13);
  });

  it('leaves real headroom against the REAL default per-IP chat limit (not an overridden test value)', () => {
    const settings = loadChatSettingsFromEnv({});
    const worstCase = maxRequestsInWindow(timestamps, settings.rateLimitIpWindowMs);
    // How many real chat sends must still fit, from the SAME IP, in the single busiest polling
    // window - a plausible number of follow-up messages a customer sends while waiting.
    const MIN_CHAT_HEADROOM = 5;
    expect(worstCase + MIN_CHAT_HEADROOM).toBeLessThanOrEqual(settings.rateLimitIpMaxRequests);
  });

  it('leaves real headroom against the REAL default per-API-key chat limit', () => {
    const settings = loadChatSettingsFromEnv({});
    const worstCase = maxRequestsInWindow(timestamps, settings.rateLimitApiKeyWindowMs);
    const MIN_CHAT_HEADROOM = 10;
    expect(worstCase + MIN_CHAT_HEADROOM).toBeLessThanOrEqual(settings.rateLimitApiKeyMaxRequests);
  });

  it("the poll endpoint's OWN dedicated bucket comfortably covers the full documented worst case", () => {
    const settings = loadChatSettingsFromEnv({});
    expect(timestamps.length).toBeLessThanOrEqual(settings.pollRateLimitMaxRequests);
  });
});
