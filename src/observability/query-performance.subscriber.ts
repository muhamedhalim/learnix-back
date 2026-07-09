import { Logger } from '@nestjs/common';

import { EventSubscriber, type EntitySubscriberInterface } from 'typeorm';
import type { AfterQueryEvent } from 'typeorm/subscriber/event/QueryEvent';

import { recordQueryForCurrentRequest, requestPerformanceStorage } from './performance-context';
import { performanceMetrics } from './performance-metrics.registry';

@EventSubscriber()
export class QueryPerformanceSubscriber implements EntitySubscriberInterface {
  private readonly logger = new Logger(QueryPerformanceSubscriber.name);
  private readonly logEveryQuery = process.env['PERFORMANCE_QUERY_LOGGING'] === 'true';
  private readonly slowQueryMs = Number(process.env['PERFORMANCE_SLOW_QUERY_MS'] ?? 100);

  public afterQuery(event: AfterQueryEvent<unknown>): void {
    const durationMs = event.executionTime ?? 0;
    const success = event.success;

    recordQueryForCurrentRequest(durationMs);
    performanceMetrics.recordQuery(durationMs, success);

    if (this.logEveryQuery || !success || durationMs >= this.slowQueryMs) {
      const operation = this.getOperation(event.query);
      const payload = {
        event: 'database_query_performance',
        requestId: requestPerformanceStorage.getStore()?.requestId,
        operation,
        durationMs: Math.round(durationMs * 1000) / 1000,
        success,
      };

      if (success) {
        this.logger.log(JSON.stringify(payload));
      } else {
        this.logger.error(JSON.stringify(payload));
      }
    }
  }

  private getOperation(query: string): string {
    const match = /^\s*([A-Za-z]+)/.exec(query);
    return match?.[1]?.toUpperCase() ?? 'UNKNOWN';
  }
}
