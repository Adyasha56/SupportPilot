import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import { Response } from 'express';

/**
 * @nestjs/platform-express's FileInterceptor ALREADY transforms raw multer
 * errors into standard Nest exceptions itself (confirmed by reading its
 * source, multer/multer.utils.ts's transformException: LIMIT_FILE_SIZE ->
 * PayloadTooLargeException, every other multer limit -> BadRequestException)
 * - so by the time any filter sees it, it's never a raw MulterError. This
 * reformats those two into this project's {statusCode, code, message}
 * shape. Scoped to exactly these two exception types, which PoliciesController
 * never throws itself for any other reason, so there's no risk of this
 * filter mis-handling an unrelated exception.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: PayloadTooLargeException | BadRequestException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const message = exception.message;

    if (exception instanceof PayloadTooLargeException) {
      response.status(413).json({ statusCode: 413, code: 'FILE_TOO_LARGE', message });
      return;
    }

    // Only other source of BadRequestException in this controller: multer's
    // other stream-level limits (files, fields, parts, etc).
    response.status(413).json({ statusCode: 413, code: 'TOO_MANY_FILES', message });
  }
}
