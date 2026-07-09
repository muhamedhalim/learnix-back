import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';

import { createRequestPerformanceContext, requestPerformanceStorage } from './performance-context';
import { performanceMetrics } from './performance-metrics.registry';

interface ExpressRoute {
  path?: unknown;
}

@Injectable()
export class RequestPerformanceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestPerformanceMiddleware.name);
  private readonly httpLoggingEnabled = process.env['PERFORMANCE_HTTP_LOGGING'] !== 'false';

  public use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const context = createRequestPerformanceContext();
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
        this.logger.log(
          JSON.stringify({
            event: 'http_request_performance',
            requestId: context.requestId,
            ...sample,
            durationMs: Math.round(sample.durationMs * 1000) / 1000,
            dbDurationMs: Math.round(sample.dbDurationMs * 1000) / 1000,
          }),
        );
      }
    };

    response.once('finish', finish);
    response.once('close', finish);
    requestPerformanceStorage.run(context, next);
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
