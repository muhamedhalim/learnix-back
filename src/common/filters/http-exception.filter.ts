import { randomUUID } from 'node:crypto';

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
import { performanceMetrics } from '../../observability/performance-metrics.registry';

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
    const requestId = this.resolveRequestId(request.headers['x-request-id']);
    response.setHeader?.('X-Request-ID', requestId);

    // Create RFC 7807 Problem Details response
    const locale = resolveRequestLocale(request);
    const problemDetails = this.createProblemDetails(exception, request, locale, requestId);
    const { status } = problemDetails;
    performanceMetrics.recordHttpException({
      method: request.method,
      route: request.route?.path ? `${request.baseUrl}${String(request.route.path)}` : 'unmatched',
      status,
      exceptionType: exception instanceof Error ? exception.name : 'UnknownError',
    });

    // Log the error with appropriate level
    const logLevel = this.getLogLevel(status);
    const requestPath = request.path || new URL(request.url, 'http://internal').pathname;
    const logMessage = `[${requestId}] ${request.method} ${requestPath} - ${String(status)} ${problemDetails.title}: ${problemDetails.detail}`;

    if (logLevel === 'error') {
      const includeStack = process.env['NODE_ENV'] !== 'production';
      this.logger.error(
        logMessage,
        includeStack && exception instanceof Error ? exception.stack : undefined,
      );
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

  private resolveRequestId(value: string | string[] | undefined): string {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate !== undefined && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)
      ? candidate
      : randomUUID();
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
