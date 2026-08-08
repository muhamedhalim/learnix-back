import type { AfterQueryEvent } from 'typeorm/subscriber/event/QueryEvent';

import { createRequestPerformanceContext, requestPerformanceStorage } from './performance-context';
import { performanceMetrics } from './performance-metrics.registry';
import { QueryPerformanceSubscriber } from './query-performance.subscriber';

describe('QueryPerformanceSubscriber', () => {
  it('attributes query count and duration to the active request', () => {
    const context = createRequestPerformanceContext('req-single');
    const subscriber = new QueryPerformanceSubscriber();

    requestPerformanceStorage.run(context, () => {
      subscriber.afterQuery({
        query: 'SELECT 1',
        success: true,
        executionTime: 2.5,
      } as AfterQueryEvent<unknown>);
    });

    expect(context.queryCount).toBe(1);
    expect(context.dbDurationMs).toBe(2.5);
    expect(performanceMetrics.renderPrometheus()).toContain(
      'backend_typeorm_queries_total{success="true"}',
    );
  });

  it('keeps 50 concurrent request contexts isolated', async () => {
    const subscriber = new QueryPerformanceSubscriber();
    // The canonical request id is now the string minted per HTTP request by
    // RequestPerformanceMiddleware, not an internal counter — so the caller
    // supplies it. Distinct ids here still prove context isolation.
    const contexts = Array.from({ length: 50 }, (_, index) =>
      createRequestPerformanceContext(`req-${index.toString()}`),
    );

    await Promise.all(
      contexts.map((context, requestIndex) =>
        requestPerformanceStorage.run(context, async () => {
          await Promise.all(
            [1, 2, 3].map(
              (queryIndex) =>
                new Promise<void>((resolve) => {
                  setTimeout(
                    () => {
                      subscriber.afterQuery({
                        query: 'SELECT 1',
                        success: true,
                        executionTime: queryIndex,
                      } as AfterQueryEvent<unknown>);
                      resolve();
                    },
                    (requestIndex + queryIndex) % 5,
                  );
                }),
            ),
          );
        }),
      ),
    );

    expect(contexts.every((context) => context.queryCount === 3)).toBe(true);
    expect(contexts.every((context) => context.dbDurationMs === 6)).toBe(true);
    expect(new Set(contexts.map((context) => context.requestId)).size).toBe(50);
  });
});
