import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RefundVerifierInput,
  RefundVerifierOrderSnapshot,
  RefundVerifierTenantSettings,
  verifyRefundProposal,
} from './refund-verifier';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const FIXED_CLOCK = () => NOW;

function daysAgo(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function daysFromNow(days: number): string {
  return daysAgo(-days);
}

function order(overrides: Partial<RefundVerifierOrderSnapshot> = {}): RefundVerifierOrderSnapshot {
  return {
    status: 'delivered',
    customerRef: 'cust_1',
    deliveredAt: daysAgo(10),
    totalCents: 10000,
    alreadyRefundedCents: 0,
    ...overrides,
  };
}

function tenantSettings(overrides: Partial<RefundVerifierTenantSettings> = {}): RefundVerifierTenantSettings {
  return {
    refundCap: 2000,
    approvalThreshold: 250,
    refundWindowDays: 30,
    autoExecuteRefunds: false,
    ...overrides,
  };
}

function input(overrides: Partial<RefundVerifierInput> = {}): RefundVerifierInput {
  return {
    proposedAmountCents: 5000,
    order: order(),
    verifiedCustomerRef: 'cust_1',
    citations: ['d1-0'],
    tenantSettings: tenantSettings(),
    customerDailyRefundCount: 0,
    clock: FIXED_CLOCK,
    ...overrides,
  };
}

describe('verifyRefundProposal - the happy path', () => {
  it('requires approval when every rule passes and autoExecuteRefunds is off', () => {
    const result = verifyRefundProposal(input());
    expect(result.decision).toBe('require_approval');
    expect(result.verdicts.every((v) => v.passed)).toBe(true);
  });
});

describe('verifyRefundProposal - each rule failing alone', () => {
  it('ORDER_OWNERSHIP_MISMATCH: the order belongs to a different customer', () => {
    const result = verifyRefundProposal(input({ verifiedCustomerRef: 'cust_2' }));
    expect(result.decision).toBe('deny');
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['ORDER_OWNERSHIP_MISMATCH']);
  });

  it('INVALID_AMOUNT: a zero amount', () => {
    const result = verifyRefundProposal(input({ proposedAmountCents: 0 }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['INVALID_AMOUNT']);
  });

  it('INVALID_AMOUNT: a negative amount', () => {
    const result = verifyRefundProposal(input({ proposedAmountCents: -100 }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['INVALID_AMOUNT']);
  });

  it('INVALID_AMOUNT: a non-integer cents value', () => {
    const result = verifyRefundProposal(input({ proposedAmountCents: 50.5 }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['INVALID_AMOUNT']);
  });

  it.each(['cancelled', 'in_transit', 'delayed'])('ORDER_STATUS_INELIGIBLE: order status %s', (status) => {
    const result = verifyRefundProposal(input({ order: order({ status }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['ORDER_STATUS_INELIGIBLE']);
  });

  it('OUTSIDE_REFUND_WINDOW: missing deliveredAt', () => {
    const result = verifyRefundProposal(input({ order: order({ deliveredAt: undefined }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['OUTSIDE_REFUND_WINDOW']);
  });

  it('OUTSIDE_REFUND_WINDOW: a future deliveredAt (anomalous data, never guessed in-window)', () => {
    const result = verifyRefundProposal(input({ order: order({ deliveredAt: daysFromNow(1) }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['OUTSIDE_REFUND_WINDOW']);
  });

  it('OUTSIDE_REFUND_WINDOW: exactly one day past the window', () => {
    const result = verifyRefundProposal(input({ order: order({ deliveredAt: daysAgo(31) }), tenantSettings: tenantSettings({ refundWindowDays: 30 }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['OUTSIDE_REFUND_WINDOW']);
  });

  it('AMOUNT_EXCEEDS_REFUND_CAP: one cent over the cap', () => {
    const result = verifyRefundProposal(
      input({ order: order({ totalCents: 10_000_000 }), proposedAmountCents: 200001, tenantSettings: tenantSettings({ refundCap: 2000 }) }),
    );
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['AMOUNT_EXCEEDS_REFUND_CAP']);
  });

  it('MISSING_POLICY_CITATION: zero citations', () => {
    const result = verifyRefundProposal(input({ citations: [] }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['MISSING_POLICY_CITATION']);
  });

  it('DAILY_REFUND_COUNT_EXCEEDED: at the configured limit', () => {
    const result = verifyRefundProposal(
      input({ tenantSettings: tenantSettings({ dailyRefundCountLimit: 3 }), customerDailyRefundCount: 3 }),
    );
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['DAILY_REFUND_COUNT_EXCEEDED']);
  });

  it('DAILY_REFUND_COUNT_EXCEEDED is never checked when no limit is configured, even with a huge count', () => {
    const result = verifyRefundProposal(input({ customerDailyRefundCount: 999 }));
    expect(result.decision).not.toBe('deny');
  });
});

describe('verifyRefundProposal - several rules failing together (amendment F: all codes returned, fixed order)', () => {
  it('a fully-refunded order fails ALREADY_FULLY_REFUNDED and AMOUNT_EXCEEDS_REMAINING_REFUNDABLE together', () => {
    const result = verifyRefundProposal(input({ order: order({ totalCents: 10000, alreadyRefundedCents: 10000 }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual([
      'ALREADY_FULLY_REFUNDED',
      'AMOUNT_EXCEEDS_REMAINING_REFUNDABLE',
    ]);
  });

  it('ownership mismatch AND zero citations together return both codes, in fixed rule order', () => {
    const result = verifyRefundProposal(input({ verifiedCustomerRef: 'cust_2', citations: [] }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['ORDER_OWNERSHIP_MISMATCH', 'MISSING_POLICY_CITATION']);
  });

  it('a cancelled order with an amount over the cap fails both independently', () => {
    const result = verifyRefundProposal(
      input({
        order: order({ status: 'cancelled', totalCents: 10_000_000 }),
        proposedAmountCents: 500000,
        tenantSettings: tenantSettings({ refundCap: 2000 }),
      }),
    );
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['ORDER_STATUS_INELIGIBLE', 'AMOUNT_EXCEEDS_REFUND_CAP']);
  });
});

describe('verifyRefundProposal - float inputs and exact-cent boundaries', () => {
  it('0.1 + 0.2-style float noise in refundCap converts to the exact cent boundary, not an off-by-one', () => {
    const refundCap = 250.1 + 0.2; // 250.30000000000001 in IEEE754
    const bigOrder = order({ totalCents: 10_000_000 });
    expect(
      verifyRefundProposal(input({ order: bigOrder, proposedAmountCents: 25030, tenantSettings: tenantSettings({ refundCap }) })).decision,
    ).not.toBe('deny');
    expect(
      verifyRefundProposal(input({ order: bigOrder, proposedAmountCents: 25031, tenantSettings: tenantSettings({ refundCap }) })).decision,
    ).toBe('deny');
  });

  it('exactly at refundCap passes; one cent over fails', () => {
    const settings = tenantSettings({ refundCap: 2000 }); // 200000 cents
    const bigOrder = order({ totalCents: 10_000_000 });
    expect(verifyRefundProposal(input({ order: bigOrder, proposedAmountCents: 200000, tenantSettings: settings })).decision).not.toBe('deny');
    expect(verifyRefundProposal(input({ order: bigOrder, proposedAmountCents: 200001, tenantSettings: settings })).decision).toBe('deny');
  });

  it('exactly at the refund window boundary passes; one day over fails', () => {
    const settings = tenantSettings({ refundWindowDays: 30 });
    const atBoundary = verifyRefundProposal(input({ order: order({ deliveredAt: daysAgo(30) }), tenantSettings: settings }));
    const overBoundary = verifyRefundProposal(input({ order: order({ deliveredAt: daysAgo(31) }), tenantSettings: settings }));
    expect(atBoundary.decision).not.toBe('deny');
    expect(overBoundary.decision).toBe('deny');
  });

  it('remainingRefundable exactly zero denies even a tiny amount', () => {
    const result = verifyRefundProposal(input({ order: order({ totalCents: 5000, alreadyRefundedCents: 5000 }), proposedAmountCents: 1 }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toContain('AMOUNT_EXCEEDS_REMAINING_REFUNDABLE');
  });

  it('amount exactly equal to remainingRefundable passes', () => {
    const result = verifyRefundProposal(input({ order: order({ totalCents: 10000, alreadyRefundedCents: 4000 }), proposedAmountCents: 6000 }));
    expect(result.decision).not.toBe('deny');
  });

  it('amount one cent over remainingRefundable fails', () => {
    const result = verifyRefundProposal(input({ order: order({ totalCents: 10000, alreadyRefundedCents: 4000 }), proposedAmountCents: 6001 }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['AMOUNT_EXCEEDS_REMAINING_REFUNDABLE']);
  });
});

describe('verifyRefundProposal - the auto/human split', () => {
  it('autoExecuteRefunds: false always requires approval, regardless of amount', () => {
    const settings = tenantSettings({ autoExecuteRefunds: false, approvalThreshold: 100000 });
    const result = verifyRefundProposal(input({ proposedAmountCents: 1, tenantSettings: settings }));
    expect(result.decision).toBe('require_approval');
  });

  it('autoExecuteRefunds: true and the amount exactly at approvalThreshold auto-executes', () => {
    const settings = tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250 });
    const result = verifyRefundProposal(input({ order: order({ totalCents: 10_000_000 }), proposedAmountCents: 25000, tenantSettings: settings }));
    expect(result.decision).toBe('auto_execute');
  });

  it('autoExecuteRefunds: true and one cent over approvalThreshold requires approval, not denial', () => {
    const settings = tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 250, refundCap: 2000 });
    const result = verifyRefundProposal(input({ order: order({ totalCents: 10_000_000 }), proposedAmountCents: 25001, tenantSettings: settings }));
    expect(result.decision).toBe('require_approval');
  });

  it('autoExecuteRefunds: true with a failed rule never auto-executes - it denies first', () => {
    const settings = tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 100000 });
    const result = verifyRefundProposal(input({ citations: [], proposedAmountCents: 1, tenantSettings: settings }));
    expect(result.decision).toBe('deny');
  });

  it('rule 7 (refundCap) is enforced even when autoExecuteRefunds is true and the amount is within approvalThreshold-sized reach - the cap is never bypassed by the flag', () => {
    const settings = tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 100000, refundCap: 2000 }); // cap = 200000 cents
    const result = verifyRefundProposal(
      input({ order: order({ totalCents: 10_000_000 }), proposedAmountCents: 200001, tenantSettings: settings }),
    );
    expect(result.decision).toBe('deny');
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['AMOUNT_EXCEEDS_REFUND_CAP']);
  });

  it('rule 7 (refundCap) denies even when approvalThreshold itself is set higher than refundCap', () => {
    // approvalThreshold alone would have allowed auto_execute at this amount, but refundCap is
    // the hard ceiling (plan §4: "never bypassed by auto-execute") and must still win.
    const settings = tenantSettings({ autoExecuteRefunds: true, approvalThreshold: 5000, refundCap: 2000 });
    const result = verifyRefundProposal(
      input({ order: order({ totalCents: 10_000_000 }), proposedAmountCents: 300000, tenantSettings: settings }),
    );
    expect(result.decision).toBe('deny');
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['AMOUNT_EXCEEDS_REFUND_CAP']);
  });
});

describe('verifyRefundProposal - verdicts cover every rule, every time', () => {
  it('returns a verdict for all 9 rules even when everything passes', () => {
    const result = verifyRefundProposal(input());
    expect(result.verdicts).toHaveLength(9);
    expect(result.verdicts.every((v) => v.passed)).toBe(true);
  });

  it('returns a verdict for all 9 rules even when several fail', () => {
    const result = verifyRefundProposal(input({ verifiedCustomerRef: 'cust_2', citations: [] }));
    expect(result.verdicts).toHaveLength(9);
    expect(result.verdicts.filter((v) => !v.passed).map((v) => v.code)).toEqual(['ORDER_OWNERSHIP_MISMATCH', 'MISSING_POLICY_CITATION']);
  });
});

describe('verifyRefundProposal - the clock is injected, never the real wall clock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never calls Date.now() - every time-based decision goes through the injected clock', () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    verifyRefundProposal(input());
    expect(dateNowSpy).not.toHaveBeenCalled();
  });

  it('never calls Date.now() even on the window-check path with a missing deliveredAt', () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    verifyRefundProposal(input({ order: order({ deliveredAt: undefined }) }));
    expect(dateNowSpy).not.toHaveBeenCalled();
  });

  it('is fully reproducible from the injected clock alone - a "today" far in the future than the real wall clock still evaluates the window correctly', () => {
    const farFutureClock = () => new Date('2099-01-01T00:00:00.000Z');
    const deliveredAt = new Date('2098-12-01T00:00:00.000Z').toISOString(); // 31 days before farFutureClock's "now"
    const result = verifyRefundProposal(input({ order: order({ deliveredAt }), clock: farFutureClock, tenantSettings: tenantSettings({ refundWindowDays: 30 }) }));
    expect(result.decision === 'deny' && result.failedRuleCodes).toEqual(['OUTSIDE_REFUND_WINDOW']);
  });
});
