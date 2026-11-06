import { Provider } from '@nestjs/common';
import { DailyGenerateBudgetGuard, InMemoryDailyGenerateBudgetGuard, TenantGenerateBudgetGuard } from '../agent/loop/daily-generate-budget';
import { LLM_SETTINGS } from '../llm/llm-settings.provider';
import { LlmSettings } from '../llm/llm.settings';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

export const DAILY_GENERATE_BUDGET = Symbol('DAILY_GENERATE_BUDGET');
export const TENANT_GENERATE_BUDGET = Symbol('TENANT_GENERATE_BUDGET');

/**
 * Exactly one path, deliberately: run-agent.ts's `attempt()` already
 * implements "check the tenant layer first, then the global layer, refund
 * the tenant ticket if the global one denies" INLINE, using two separate
 * RunAgentDeps fields (dailyGenerateBudget, tenantGenerateBudget - see that
 * file's own doc comments). This is why these two providers construct the
 * PLAIN InMemoryDailyGenerateBudgetGuard and TenantGenerateBudgetGuard
 * directly, never the TenantAndGlobalGenerateBudgetGuard composite -
 * wiring the composite into dailyGenerateBudget here, on TOP of the
 * tenantGenerateBudget provider below, would double-charge every tenant
 * (once via run-agent.ts's own explicit tenant check, again inside the
 * composite's own tryConsume). The composite stays a tested, standalone
 * utility (agent/loop/daily-generate-budget.spec.ts) for a caller that
 * wants a single opaque DailyGenerateBudgetGuard and doesn't need to know
 * which layer denied a call - chat.module.ts is not that caller.
 */
export const dailyGenerateBudgetProvider: Provider = {
  provide: DAILY_GENERATE_BUDGET,
  inject: [LLM_SETTINGS],
  useFactory: (settings: LlmSettings): DailyGenerateBudgetGuard => new InMemoryDailyGenerateBudgetGuard(settings.dailyGenerateBudget, () => new Date()),
};

/** The per-tenant layer - Stage 4 item 2, UTC-calendar-day reset (see daily-generate-budget.ts's own doc comment). */
export const tenantGenerateBudgetProvider: Provider = {
  provide: TENANT_GENERATE_BUDGET,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings): DailyGenerateBudgetGuard =>
    new TenantGenerateBudgetGuard({ maxPerTenantPerDay: settings.tenantDailyGenerateBudget, maxEntries: 2000 }, () => new Date()),
};
