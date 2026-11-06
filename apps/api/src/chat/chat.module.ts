import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ToolRunnerModule } from '../agent/tool-runner/tool-runner.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { chatApiKeyGuardSettingsProvider } from './chat-api-key-guard-settings.provider';
import { chatSettingsProvider } from './chat-settings.provider';
import { runAgentSettingsProvider } from './run-agent-settings.provider';
import { dailyGenerateBudgetProvider, tenantGenerateBudgetProvider } from './budget-guards.provider';
import { readOnlyToolRunnerProvider } from './read-only-tool-runner.provider';
import { tenantRateLimiterProvider, customerRefRateLimiterProvider } from './rate-limiters.provider';
import { conversationLockProvider } from './conversation-lock.provider';
import { inFlightRunLimiterProvider } from './in-flight-run-limiter.provider';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * A plain, exported function - not an inline expression - same reasoning
 * and same pattern as ingestion.module.ts's own ingestionDatabaseImportsFor
 * (see that file's doc comment): lets chat.module.spec.ts call this
 * directly with a fake env object, and keeps this module importable (and
 * every /v1/chat route therefore existing and returning a real 503,
 * never a bare 404) whether or not MONGODB_URI is set.
 */
export function chatDatabaseImportsFor(env: NodeJS.ProcessEnv): [typeof DatabaseModule] | [] {
  return env.MONGODB_URI ? [DatabaseModule] : [];
}

/**
 * ChatModule provides its OWN ApiKeyGuard + API_KEY_GUARD_SETTINGS
 * (chat-api-key-guard-settings.provider.ts), rather than importing
 * AuthModule - see that provider's own doc comment for why: this route's
 * IP/key rate limits (ChatSettings's rateLimitIp... and rateLimitApiKey... fields) need to
 * be sized differently from every other /v1/* route's default, and two
 * independent guard instances with independent limiter state is how that
 * stays possible without changing AuthModule's own defaults.
 *
 * Exactly one generate-budget path (Stage 4 item 2): dailyGenerateBudgetProvider
 * and tenantGenerateBudgetProvider construct the PLAIN guards, never the
 * TenantAndGlobalGenerateBudgetGuard composite - see budget-guards.provider.ts's
 * own doc comment for why wiring the composite here too would double-charge
 * every tenant.
 */
@Module({
  imports: [LlmModule, RetrievalModule, ToolRunnerModule, ConnectorsModule, ...chatDatabaseImportsFor(process.env)],
  controllers: [ChatController],
  providers: [
    ApiKeyGuard,
    chatApiKeyGuardSettingsProvider,
    chatSettingsProvider,
    runAgentSettingsProvider,
    dailyGenerateBudgetProvider,
    tenantGenerateBudgetProvider,
    readOnlyToolRunnerProvider,
    tenantRateLimiterProvider,
    customerRefRateLimiterProvider,
    conversationLockProvider,
    inFlightRunLimiterProvider,
    ChatService,
  ],
})
export class ChatModule {}
