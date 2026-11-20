import { Controller, Get, Param, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ConversationMessagesResponse } from '@supportpilot/shared';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentApiKeyScope } from '../auth/current-api-key.decorator';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { RequireScope } from '../auth/require-scope.decorator';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { ChatRetryAfterFilter } from './chat-retry-after.filter';
import { conversationMessagesHttpError } from './conversation-messages-http-error';
import { ConversationMessagesService } from './conversation-messages.service';

/**
 * Milestone 5, Stage 1a, amendment A6 - deliberately mounted under
 * `v1/chat/conversations`, inside THIS same controller family (ChatModule),
 * never a new module: it needs the exact same `ApiKeyGuard` singleton
 * instance ChatController uses (so polling traffic shares the same per-IP/
 * per-API-key guard-level limiter as chat-sending traffic, verified against
 * the documented polling cadence by poll-rate-limit-headroom.spec.ts) and
 * the same `@RequireScope('public')` - a public key must reach this route
 * exactly as it reaches POST /v1/chat, and a secret key must too (the
 * one-directional scope relationship api-key.guard.ts documents).
 * `/v1/chat/conversations/:id/messages` also shares the `/v1/chat` prefix
 * the CORS delegate (common/cors.ts) opens up for the widget - no separate
 * CORS entry needed.
 */
@Controller('v1/chat/conversations')
@UseGuards(ApiKeyGuard)
@RequireScope('public')
@UseFilters(ChatRetryAfterFilter)
export class ConversationMessagesController {
  constructor(private readonly conversationMessagesService: ConversationMessagesService) {}

  @Get(':id/messages')
  async getMessages(
    @CurrentTenant() tenantId: string,
    @CurrentApiKeyScope() matchedScope: ApiKeyScope,
    @Param('id') conversationId: string,
    @Req() request: Request,
  ): Promise<ConversationMessagesResponse> {
    const result = await this.conversationMessagesService.getMessages({
      tenantId,
      matchedScope,
      conversationId,
      rawQuery: request.query,
    });
    if (result.kind === 'error') {
      throw conversationMessagesHttpError(result.code, result.message, result.retryAfterSeconds);
    }
    return result.body;
  }
}
