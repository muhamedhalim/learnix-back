import type { DataSource, EntitySubscriberInterface } from 'typeorm';
import type { AfterQueryEvent } from 'typeorm/subscriber/event/QueryEvent';

import { getCurrentRequestId } from '../../../src/observability/performance-context';

/**
 * Test-only SQL statement counter for e2e specs (spec 004, T003).
 *
 * It attaches a TypeORM `afterQuery` subscriber to the e2e `DataSource` — the same hook
 * `QueryPerformanceSubscriber` uses for the production `queryCount` — so a statement here is
 * counted exactly as `queryCount` counts it: every statement sent through a query runner,
 * including `START TRANSACTION` / `COMMIT` / `ROLLBACK` and failed statements.
 *
 * It exists because the production counter cannot be read per request from an e2e test (it is
 * only exposed through the `http_request` log line and aggregate Prometheus sums) and has no
 * table filter. Nothing under `src/` is changed and nothing here ships to production.
 *
 * Usage:
 *
 *   const counter = new StatementCounter(ctx.dataSource);
 *   counter.start();
 *   await agent.get(`${API_PREFIX}/some/route`).set('X-Request-Id', 'probe-1').expect(200);
 *   counter.stop();
 *   expect(counter.count({ requestId: 'probe-1' })).toBe(0);
 *   expect(counter.count({ requestId: 'probe-1', table: 'user_sessions' })).toBe(1);
 *
 * Prefer the `requestId` filter over the unfiltered total: the application under test is live,
 * so post-commit listeners, cron jobs and queue workers may issue statements inside the window.
 * `RequestPerformanceMiddleware` honours a well-formed inbound `X-Request-Id`, and
 * `getCurrentRequestId()` reads it back from the same AsyncLocalStorage context the production
 * counter uses. Statements issued outside an HTTP request (test setup, workers) carry no id.
 */
export interface RecordedStatement {
  readonly sql: string;
  readonly requestId: string | undefined;
  readonly success: boolean;
}

export interface StatementFilter {
  /** Match statements that reference this table, quoted or not, optionally schema-qualified. */
  readonly table?: string;
  /** Match statements issued while serving the request that carried this `X-Request-Id`. */
  readonly requestId?: string;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** True when `table` appears as a whole identifier (not as a fragment of a longer name). */
function referencesTable(sql: string, table: string): boolean {
  return new RegExp(`(?<!\\w)${escapeRegExp(table)}(?!\\w)`, 'iu').test(sql);
}

export class StatementCounter {
  private readonly recorded: RecordedStatement[] = [];
  private active = false;

  private readonly subscriber: EntitySubscriberInterface = {
    afterQuery: (event: AfterQueryEvent<unknown>): void => {
      if (!this.active) return;
      this.recorded.push({
        sql: event.query,
        requestId: getCurrentRequestId(),
        success: event.success,
      });
    },
  };

  public constructor(private readonly dataSource: DataSource) {}

  /** Discard anything recorded so far and begin counting. */
  public start(): void {
    this.recorded.length = 0;
    if (!this.dataSource.subscribers.includes(this.subscriber)) {
      this.dataSource.subscribers.push(this.subscriber);
    }
    this.active = true;
  }

  /** Stop counting and detach from the `DataSource`. Returns the statements recorded. */
  public stop(): readonly RecordedStatement[] {
    this.active = false;
    const index = this.dataSource.subscribers.indexOf(this.subscriber);
    if (index !== -1) {
      this.dataSource.subscribers.splice(index, 1);
    }
    return [...this.recorded];
  }

  /** Number of recorded statements that satisfy every supplied filter field. */
  public count(filter: StatementFilter = {}): number {
    return this.statements(filter).length;
  }

  /** The recorded statements that satisfy every supplied filter field (for assertion messages). */
  public statements(filter: StatementFilter = {}): readonly RecordedStatement[] {
    return this.recorded.filter(
      (statement) =>
        (filter.requestId === undefined || statement.requestId === filter.requestId) &&
        (filter.table === undefined || referencesTable(statement.sql, filter.table)),
    );
  }
}
