import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';

/**
 * Stage 6 item 3 - a real, empirically-confirmed gap: ChatController's own
 * body-size check (chat.controller.ts's enforceBodySize) only ever runs
 * AFTER Nest's global body-parser middleware has already succeeded -
 * guards, interceptors, and controller-scoped @UseFilters() all run AFTER
 * middleware in Nest's request lifecycle, so a body that fails to parse AT
 * ALL (too large, or syntactically invalid JSON) never reaches this
 * controller, its own check, or even a controller-scoped exception filter.
 * Confirmed directly (not assumed) with a throwaway probe against a bare
 * Nest app: an oversized body throws a plain `PayloadTooLargeError` (NOT an
 * HttpException - a bare http-errors object with status/type/expose
 * properties), and a malformed-JSON body throws a NestJS BadRequestException
 * - both ONLY visible to a GLOBAL filter, confirmed by the SAME probe
 * showing a controller-scoped @UseFilters() catches neither.
 *
 * Scoped to the /v1/chat path specifically (checked via the real request,
 * not inferred from the exception) so every OTHER route's existing body-
 * parser error handling is completely untouched - `super.catch()` runs for
 * anything else, identical to Nest's own default global filter.
 *
 * `exception instanceof BadRequestException` (the concrete subclass, not
 * plain HttpException) is what distinguishes a body-parser-originated 400
 * from chat's OWN 400s: chat-http-error.ts's chatHttpError always
 * constructs a plain `new HttpException(...)`, never the BadRequestException
 * subclass - so by the time a BadRequestException reaches this filter for
 * the chat path, it can only have come from body parsing, never from
 * ChatController's own (always-later) validation.
 */
@Catch()
export class ChatBodyParserErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    if (!request.originalUrl?.startsWith('/v1/chat')) {
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();

    if (isBodyTooLarge(exception)) {
      response.status(413).json({ statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured byte limit.' });
      return;
    }

    if (exception instanceof BadRequestException) {
      response.status(400).json({ statusCode: 400, code: 'INVALID_REQUEST', message: 'The request body is invalid.' });
      return;
    }

    super.catch(exception, host);
  }
}

function isBodyTooLarge(exception: unknown): boolean {
  return typeof exception === 'object' && exception !== null && (exception as { type?: unknown }).type === 'entity.too.large';
}
