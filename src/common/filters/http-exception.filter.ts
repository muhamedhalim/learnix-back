import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

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
  errors?: string[];
}

interface NestExceptionResponse {
  error?: string;
  message?: string | string[];
  statusCode?: number;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Create RFC 7807 Problem Details response
    const problemDetails = this.createProblemDetails(exception, request);
    const { status } = problemDetails;

    // Log the error with appropriate level
    const logLevel = this.getLogLevel(status);
    const logMessage = `${request.method} ${request.url} - ${status} ${problemDetails.title}: ${problemDetails.detail}`;

    if (logLevel === 'error') {
      this.logger.error(
        logMessage,
        exception instanceof Error ? exception.stack : undefined,
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
  ): ProblemDetails {
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred';
    let type = 'about:blank';
    let errors: string[] | undefined = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Extract error details from NestJS validation errors
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as NestExceptionResponse;

        title = responseObj.error || exception.name;
        detail = Array.isArray(responseObj.message)
          ? responseObj.message.join(', ')
          : responseObj.message || detail;

        // Include validation errors if present
        if (responseObj.message && Array.isArray(responseObj.message)) {
          errors = responseObj.message;
        }
      } else if (typeof exceptionResponse === 'string') {
        detail = exceptionResponse;
        title = exception.name;
      }

      // Map HTTP status to descriptive title
      type = this.getTypeFromStatus(status);
    } else if (exception instanceof Error) {
      // Handle non-HTTP errors - hide sensitive details in production
      const isProduction = process.env.NODE_ENV === 'production';
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

    // Include validation errors if present
    if (errors) {
      problemDetails.errors = errors;
    }

    return problemDetails;
  }

  /**
   * Map HTTP status code to RFC 7807 type URI
   */
  private getTypeFromStatus(status: number): string {
    const typeMap: Record<number, string> = {
      400: 'https://httpstatuses.com/400',
      401: 'https://httpstatuses.com/401',
      403: 'https://httpstatuses.com/403',
      404: 'https://httpstatuses.com/404',
      409: 'https://httpstatuses.com/409',
      422: 'https://httpstatuses.com/422',
      429: 'https://httpstatuses.com/429',
      500: 'https://httpstatuses.com/500',
      502: 'https://httpstatuses.com/502',
      503: 'https://httpstatuses.com/503',
    };

    return typeMap[status] || 'about:blank';
  }

  /**
   * Get appropriate log level based on HTTP status
   */
  private getLogLevel(status: number): 'error' | 'warn' | 'log' {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'log';
  }
}
