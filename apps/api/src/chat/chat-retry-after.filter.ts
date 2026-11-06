import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Stage 5 item 7 - sets the real Retry-After HTTP header on every 429/409
 * response that carries a retryAfterSeconds hint in its JSON body
 * (chat-http-error.ts's chatHttpError), so a well-behaved client can read
 * the standard header instead of having to parse the body. Scoped to
 * HttpException generally (not just ChatErrorCode ones) so it's a no-op,
 * never a crash, for any other exception this controller might someday
 * throw that has no such field.
 */
@Catch(HttpException)
export class ChatRetryAfterFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null && 'retryAfterSeconds' in body) {
      const retryAfterSeconds = (body as { retryAfterSeconds: unknown }).retryAfterSeconds;
      if (typeof retryAfterSeconds === 'number') {
        response.setHeader('Retry-After', String(retryAfterSeconds));
      }
    }

    response.status(status).json(body);
  }
}
