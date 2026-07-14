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

    // Create RFC 7807 Problem Details response
    const locale = resolveRequestLocale(request);
    const problemDetails = this.createProblemDetails(exception, request, locale);
    const { status } = problemDetails;

    // Log the error with appropriate level
    const logLevel = this.getLogLevel(status);
    const logMessage = `${request.method} ${request.url} - ${String(status)} ${problemDetails.title}: ${problemDetails.detail}`;

    if (logLevel === 'error') {
      this.logger.error(logMessage, exception instanceof Error ? exception.stack : undefined);
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
      instance: request.url,
      timestamp: new Date().toISOString(),
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
   * Map HTTP status code to RFC 7807 type URI
   */
  private getTypeFromStatus(status: number): string {
    const typeMap = new Map<number, string>([
      [400, 'https://httpstatuses.com/400'],
      [401, 'https://httpstatuses.com/401'],
      [403, 'https://httpstatuses.com/403'],
      [404, 'https://httpstatuses.com/404'],
      [409, 'https://httpstatuses.com/409'],
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
