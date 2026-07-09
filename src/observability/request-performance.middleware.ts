import { randomUUID } from 'node:crypto';

import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';

import { createRequestPerformanceContext, requestPerformanceStorage } from './performance-context';
import { performanceMetrics } from './performance-metrics.registry';

interface ExpressRoute {
  path?: unknown;
}

interface AuthenticatedUser {
  userId?: string;
  tenantId?: string;
}

const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestPerformanceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestPerformanceMiddleware.name);
  private readonly httpLoggingEnabled = process.env['PERFORMANCE_HTTP_LOGGING'] !== 'false';

  public use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const context = createRequestPerformanceContext();

    // Stable per-request correlation id: honour an inbound X-Request-Id (from a
    // load balancer / gateway) or mint a new UUID, and echo it on the response
    // so clients and logs can be correlated.
    const inboundId = request.headers[REQUEST_ID_HEADER];
    const correlationId =
      typeof inboundId === 'string' && inboundId !== '' ? inboundId : randomUUID();
    response.setHeader(REQUEST_ID_HEADER, correlationId);

    let completed = false;

    const finish = (): void => {
      if (completed) return;
      completed = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const responseBytes = this.getResponseBytes(response);
      const route = this.getRoute(request);
      const sample = {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs,
        queryCount: context.queryCount,
        dbDurationMs: context.dbDurationMs,
        responseBytes,
      };

      performanceMetrics.recordHttp(sample);

      if (this.httpLoggingEnabled) {
        // Structured JSON. Only safe, non-PII fields are logged (no bodies,
        // headers, tokens, emails). userId/tenantId identify the principal
        // without exposing personal data.
        const user = (request as Request & { user?: AuthenticatedUser }).user;
        this.logger.log(
          JSON.stringify({
            event: 'http_request',
            requestId: correlationId,
            method: sample.method,
            route: sample.route,
            statusCode: sample.status,
            durationMs: Math.round(sample.durationMs * 1000) / 1000,
            dbDurationMs: Math.round(sample.dbDurationMs * 1000) / 1000,
            queryCount: sample.queryCount,
            responseBytes: sample.responseBytes,
            userId: user?.userId ?? null,
            tenantId: user?.tenantId ?? null,
            ip: this.getClientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          }),
        );
      }
    };

    response.once('finish', finish);
    response.once('close', finish);
    requestPerformanceStorage.run(context, next);
  }

  /** First hop from X-Forwarded-For (behind the trusted proxy) or socket IP. */
  private getClientIp(request: Request): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded !== '') {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    return request.ip ?? null;
  }

  private getRoute(request: Request): string {
    const route = request.route as ExpressRoute | undefined;
    const path = typeof route?.path === 'string' ? route.path : undefined;
    if (!path) return 'unmatched';

    return `${request.baseUrl}${path}` || '/';
  }

  private getResponseBytes(response: Response): number {
    const value = response.getHeader('content-length');
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const bytes = Number(value);
      return Number.isFinite(bytes) ? bytes : 0;
    }
    return 0;
  }
}
