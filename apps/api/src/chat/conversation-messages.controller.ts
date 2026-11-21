import { Controller, Get, Headers, Param, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConversationMessagesResponse } from '@supportpilot/shared';
import { CurrentApiKeyScope } from '../auth/current-api-key.decorator';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { RequireScope } from '../auth/require-scope.decorator';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { ChatRetryAfterFilter } from './chat-retry-after.filter';
import { conversationMessagesHttpError } from './conversation-messages-http-error';
import { ConversationMessagesService } from './conversation-messages.service';
import { PollApiKeyGuard } from './poll-api-key-guard';

/**
 * Milestone 5, Stage 1a, amendment A6 - mounted under `v1/chat/conversations`
 * (still inside ChatModule, so it shares its `/v1/chat` CORS entry - no
 * separate CORS config needed) but, since Part 0 item P1's fix, guarded by
 * `PollApiKeyGuard` - its OWN `ApiKeyGuard` instance with its OWN per-IP/
 * per-key buckets, deliberately NOT shared with `ChatController`'s. Same
 * `@RequireScope('public')` as POST /v1/chat - a public key must reach this
 * route exactly as it reaches chat, and a secret key must too (the
 * one-directional scope relationship api-key.guard.ts documents).
 */
@Controller('v1/chat/conversations')
@UseGuards(PollApiKeyGuard)
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
    @Res({ passthrough: true }) response: Response,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ): Promise<ConversationMessagesResponse | undefined> {
    const result = await this.conversationMessagesService.getMessages({
      tenantId,
      matchedScope,
      conversationId,
      rawQuery: request.query,
      ifNoneMatch,
    });
    if (result.kind === 'error') {
      throw conversationMessagesHttpError(result.code, result.message, result.retryAfterSeconds);
    }
    response.setHeader('ETag', result.etag);
    if (result.kind === 'not_modified') {
      response.status(304);
      return undefined;
    }
    return result.body;
  }
}
