import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';

import { getClientIp as resolveClientIp } from '../common/utils/client-ip.util';
import { processEnvReader } from '../common/utils/redis-connection.util';
import { resolveAppEnvLabel } from '../config/app-env';
import {
  createRequestPerformanceContext,
  REQUEST_ID_HEADER,
  requestPerformanceStorage,
  resolveRequestId,
} from './performance-context';
import { performanceMetrics } from './performance-metrics.registry';
import { resolveRelease } from './release';

interface ExpressRoute {
  path?: unknown;
}

interface AuthenticatedUser {
  userId?: string;
  role?: string;
  tenantId?: string;
}

@Injectable()
export class RequestPerformanceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestPerformanceMiddleware.name);
  private readonly httpLoggingEnabled = process.env['PERFORMANCE_HTTP_LOGGING'] !== 'false';
  /** Resolved once: these are process-lifetime constants. */
  private readonly environment = resolveAppEnvLabel(processEnvReader());
  private readonly release = resolveRelease(processEnvReader()) ?? null;

  public use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    // THE canonical correlation id for this request. Honour a well-formed
    // inbound X-Request-Id (load balancer / gateway / client) or mint a UUID —
    // then write it back onto the request so every later reader sees the same
    // value instead of minting its own. This, plus the AsyncLocalStorage
    // context below, is what makes one request use one id in the access log,
    // the error response body, the database timing log, and Sentry.
    const correlationId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    request.headers[REQUEST_ID_HEADER] = correlationId;
    response.setHeader('X-Request-Id', correlationId);

    const context = createRequestPerformanceContext(correlationId);

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
        // headers, tokens, emails). userId/role identify the principal
        // without exposing personal data. `release` lets an error spike be
        // attributed to the deployment that introduced it.
        const user = (request as Request & { user?: AuthenticatedUser }).user;
        this.logger.log(
          JSON.stringify({
            event: 'http_request',
            requestId: context.requestId,
            method: sample.method,
            route: sample.route,
            statusCode: sample.status,
            durationMs: Math.round(sample.durationMs * 1000) / 1000,
            dbDurationMs: Math.round(sample.dbDurationMs * 1000) / 1000,
            queryCount: sample.queryCount,
            responseBytes: sample.responseBytes,
            userId: user?.userId ?? null,
            role: user?.role ?? null,
            tenantId: user?.tenantId ?? null,
            environment: this.environment,
            release: this.release,
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
    return resolveClientIp(request);
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
