import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import { Request, Response } from 'express';

import {
  resolveRequestLocale,
  translateBody,
  translateMessage,
  translateMessages,
} from '../../i18n/error-translator.util';
import {
  getCurrentRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from '../../observability/performance-context';
import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { captureHandledException } from '../../observability/sentry';

/**
 * RFC 7807 Problem Details for HTTP APIs
 * https://tools.ietf.org/html/rfc7807
 *
 * This global exception filter standardizes error responses across the API
 * using the Problem Details specification.
 */

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  timestamp: string;
  requestId: string;
  path?: string;
  method?: string;
  /** Stable machine-readable error code when the exception supplies one. */
  code?: string;
  errors?: string[];
}

interface NestExceptionResponse {
  error?: string;
  message?: string | string[];
  message_ar?: string;
  errors?: string[];
  code?: string;
  statusCode?: number;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    // THE canonical id for this request, established once by
    // RequestPerformanceMiddleware. Read from the AsyncLocalStorage context
    // first, then the (middleware-normalised) request header. Minting a fresh
    // id here is a last-resort fallback for a request that never passed
    // through the middleware — previously it was the common path, which is
    // why the id in this response body did not match any log line.
    const requestId = getCurrentRequestId() ?? resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    response.setHeader?.('X-Request-Id', requestId);

    // Create RFC 7807 Problem Details response
    const locale = resolveRequestLocale(request);
    const problemDetails = this.createProblemDetails(exception, request, locale, requestId);
    const { status } = problemDetails;
    const route = request.route?.path
      ? `${request.baseUrl}${String(request.route.path)}`
      : 'unmatched';
    performanceMetrics.recordHttpException({
      method: request.method,
      route,
      status,
      exceptionType: exception instanceof Error ? exception.name : 'UnknownError',
    });

    // Log the error with appropriate level
    const logLevel = this.getLogLevel(status);
    const requestPath = request.path || new URL(request.url, 'http://internal').pathname;
    const logMessage = `[${requestId}] ${request.method} ${requestPath} - ${String(status)} ${problemDetails.title}: ${problemDetails.detail}`;

    if (logLevel === 'error') {
      // The stack is logged in EVERY environment, production included. It is
      // written to the server log only — `createProblemDetails` separately
      // withholds internal detail from the client response (see the
      // `isProduction` branch there), which is the control that actually
      // protects the API surface. Suppressing it here as well meant a
      // production 500 left no stack trace anywhere at all.
      this.logger.error(logMessage, exception instanceof Error ? exception.stack : undefined);

      // Server-side faults are the ones worth an alert. Expected client errors
      // (400/401/403/404/409/422/429) are deliberately not reported: they are
      // normal traffic, and reporting them would bury real incidents.
      const user = (request as Request & { user?: { userId?: string; role?: string } }).user;
      captureHandledException(exception, {
        requestId,
        method: request.method,
        route,
        status,
        userId: user?.userId,
        role: user?.role,
      });
    } else if (logLevel === 'warn') {
      this.logger.warn(logMessage);
    } else {
      this.logger.log(logMessage);
    }

    // Send RFC 7807 compliant response
    response.status(status).json(problemDetails);
  }

  /**
   * Generate RFC 7807 Problem Details object
   */
  private createProblemDetails(
    exception: unknown,
    request: Request,
    locale: ReturnType<typeof resolveRequestLocale>,
    requestId: string,
  ): ProblemDetails {
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred';
    let type = 'about:blank';
    let errors: string[] | undefined = undefined;
    let code: string | undefined = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Extract error details from NestJS validation errors
      if (typeof exceptionResponse === 'object') {
        const responseObj = translateBody(
          exceptionResponse as unknown as Record<string, unknown>,
          locale,
        ) as unknown as NestExceptionResponse;

        title = responseObj.error ?? exception.name;
        code = typeof responseObj.code === 'string' ? responseObj.code : undefined;
        detail = Array.isArray(responseObj.message)
          ? translateMessages(responseObj.message, locale).join(', ')
          : responseObj.message !== undefined
            ? translateMessage(responseObj.message, locale)
            : detail;

        // Include validation errors if present (either the class-validator
        // shape, where `message` itself is the array, or the question-type
        // registry shape, which keeps `message` human-readable and puts the
        // per-field failures in a sibling `errors` array).
        if (Array.isArray(responseObj.message)) {
          errors = translateMessages(responseObj.message, locale);
        } else if (Array.isArray(responseObj.errors)) {
          errors = translateMessages(responseObj.errors, locale);
        }
      } else if (typeof exceptionResponse === 'string') {
        detail = translateMessage(exceptionResponse, locale);
        title = exception.name;
      }

      // Map HTTP status to descriptive title
      type = this.getTypeFromStatus(status);
    } else if (this.isMulterError(exception)) {
      // Multer aborts an over-limit or malformed multipart upload with its own
      // Error subclass (not an HttpException). Without this branch it would fall
      // through to a generic 500; surface the real, safe status instead so the
      // client gets an actionable 413/400 rather than an "unexpected error".
      const multerCode = (exception as { code?: string }).code;
      if (multerCode === 'LIMIT_FILE_SIZE') {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        title = 'Payload Too Large';
        detail = translateMessage('Uploaded file exceeds the maximum allowed size.', locale);
      } else {
        status = HttpStatus.BAD_REQUEST;
        title = 'Bad Request';
        detail = translateMessage('The uploaded file could not be processed.', locale);
      }
      code = multerCode;
      type = this.getTypeFromStatus(status);
    } else if (exception instanceof Error) {
      // Handle non-HTTP errors - hide sensitive details in production
      const isProduction = process.env['NODE_ENV'] === 'production';
      detail = isProduction
        ? 'An unexpected error occurred. Please try again later.'
        : exception.message;
      title = isProduction ? 'Internal Server Error' : exception.name;
      type = 'about:blank';
    }

    const problemDetails: ProblemDetails = {
      type,
      title,
      status,
      detail,
      instance: request.path,
      timestamp: new Date().toISOString(),
      requestId,
      path: request.path,
      method: request.method,
    };

    if (code !== undefined) {
      problemDetails.code = code;
    }

    // Include validation errors if present
    if (errors !== undefined) {
      problemDetails.errors = errors;
    }

    return problemDetails;
  }

  /**
   * Detect a Multer upload error (e.g. LIMIT_FILE_SIZE) without importing
   * multer here. Multer errors are plain `Error`s named 'MulterError' carrying
   * a stable string `code`.
   */
  private isMulterError(exception: unknown): boolean {
    return (
      exception instanceof Error &&
      exception.name === 'MulterError' &&
      typeof (exception as { code?: unknown }).code === 'string'
    );
  }

  /**
   * Map HTTP status code to RFC 7807 type URI
   */
  private getTypeFromStatus(status: number): string {
    const typeMap = new Map<number, string>([
      [400, 'https://httpstatuses.com/400'],
      [401, 'https://httpstatuses.com/401'],
      [403, 'https://httpstatuses.com/403'],
      [404, 'https://httpstatuses.com/404'],
      [409, 'https://httpstatuses.com/409'],
      [413, 'https://httpstatuses.com/413'],
      [422, 'https://httpstatuses.com/422'],
      [429, 'https://httpstatuses.com/429'],
      [500, 'https://httpstatuses.com/500'],
      [502, 'https://httpstatuses.com/502'],
      [503, 'https://httpstatuses.com/503'],
    ]);

    return typeMap.get(status) ?? 'about:blank';
  }

  /**
   * Get appropriate log level based on HTTP status
   */
  private getLogLevel(status: number): 'error' | 'warn' | 'log' {
    if (status >= 500) {
      return 'error';
    }
    if (status >= 400) {
      return 'warn';
    }
    return 'log';
  }
}
