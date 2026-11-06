import { Body, Controller, HttpCode, Inject, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ChatResult } from '@supportpilot/shared';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentApiKeyScope } from '../auth/current-api-key.decorator';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { RequireScope } from '../auth/require-scope.decorator';
import { ApiKeyScope } from '../db/schemas/api-key.schema';
import { ChatRetryAfterFilter } from './chat-retry-after.filter';
import { chatHttpError } from './chat-http-error';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';
import { ChatService } from './chat.service';

/**
 * @RequireScope('public') - deliberately the WEAKER of the two scopes, not
 * 'secret': ApiKeyGuard's scopeSatisfies() treats secret as a strict
 * superset of public (Stage 3), so requiring 'public' here is what lets
 * BOTH a widget's public key AND a server-to-server secret key reach this
 * route, while a public key still can never reach an ACTUALLY
 * secret-only route elsewhere. Requiring 'secret' here would wrongly lock
 * the widget out entirely.
 *
 * Body size (Stage 5 item 2): NOT enforced via a route-scoped Express
 * body-parser (apps/api has no direct `express` dependency - the same gap
 * ingestion/policies.controller.ts's own doc comment already flags for
 * multer) - enforced here instead, explicitly, against
 * ChatSettings.maxBodyBytes: once via the Content-Length header (catches
 * the common case before Nest's own global body-parser has done any real
 * parsing work) and again against the actual parsed body's serialized
 * size (catches a chunked request with no Content-Length header). Both
 * checks produce this project's own {statusCode, code, message} shape -
 * never the default body-parser error shape, which is exactly what this
 * item's own instructions call out as the wrong one to leak through.
 * Known, accepted gap: a chunked request with NO Content-Length that
 * exceeds Nest's own GLOBAL default parser limit (typically ~100kb) is
 * rejected by Nest itself, in ITS shape, before this controller ever
 * runs - shared by every other route in this app today, not specific to
 * chat, and out of this stage's scope to fix app-wide.
 */
@Controller('v1/chat')
@UseGuards(ApiKeyGuard)
@RequireScope('public')
@UseFilters(ChatRetryAfterFilter)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  @Post()
  @HttpCode(200)
  async chat(
    @CurrentTenant() tenantId: string,
    @CurrentApiKeyScope() matchedScope: ApiKeyScope,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<ChatResult> {
    this.enforceBodySize(request, body);

    const result = await this.chatService.handle({ tenantId, matchedScope, rawBody: body });
    if (result.kind === 'error') {
      throw chatHttpError(result.code, result.message, result.retryAfterSeconds);
    }
    return result.body;
  }

  private enforceBodySize(request: Request, body: unknown): void {
    const contentLengthHeader = request.headers['content-length'];
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > this.settings.maxBodyBytes) {
      throw chatHttpError('REQUEST_TOO_LARGE', `Request body exceeds the ${this.settings.maxBodyBytes}-byte limit.`);
    }

    const actualBytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8');
    if (actualBytes > this.settings.maxBodyBytes) {
      throw chatHttpError('REQUEST_TOO_LARGE', `Request body exceeds the ${this.settings.maxBodyBytes}-byte limit.`);
    }
  }
}
