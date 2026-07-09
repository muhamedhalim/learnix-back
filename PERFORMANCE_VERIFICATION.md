# Performance Verification Evidence

**Executed:** 2026-07-09  
**Database:** PostgreSQL 18.3 from the configured `DATABASE_URL`  
**Load tool:** autocannon 8.0.0

## 1. Revenue query: actual SQL and plan

This is the complete SQL executed with the UTC boundary values used during the
verification:

```sql
SELECT
  COALESCE(SUM("payment"."final_amount"), 0) AS "total_revenue",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."created_at" >= '2026-07-09T00:00:00.000Z'
  ), 0) AS "revenue_today",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."created_at" >= '2026-07-01T00:00:00.000Z'
  ), 0) AS "revenue_this_month",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."created_at" >= '2026-06-01T00:00:00.000Z'
      AND "payment"."created_at" < '2026-07-01T00:00:00.000Z'
  ), 0) AS "revenue_last_month",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."created_at" >= '2026-07-01T00:00:00.000Z'
  ), 0) AS "revenue_this_quarter",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."item_type" = 'lesson'
  ), 0) AS "lesson_revenue",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."item_type" = 'package'
  ), 0) AS "package_revenue",
  COALESCE(SUM("payment"."final_amount") FILTER (
    WHERE "payment"."item_type" = 'book'
  ), 0) AS "book_revenue"
FROM "payments" "payment"
WHERE "payment"."status" = 'completed';
```

Actual returned row:

```json
{
  "total_revenue": "0",
  "revenue_today": "0",
  "revenue_this_month": "0",
  "revenue_last_month": "0",
  "revenue_this_quarter": "0",
  "lesson_revenue": "0",
  "package_revenue": "0",
  "book_revenue": "0"
}
```

Actual `EXPLAIN (ANALYZE, BUFFERS)`:

```text
Aggregate  (cost=8.21..8.22 rows=1 width=256) (actual time=0.010..0.010 rows=1.00 loops=1)
  Buffers: shared hit=1
  ->  Index Scan using "IDX_payments_status" on payments payment  (cost=0.14..8.16 rows=1 width=28) (actual time=0.008..0.008 rows=0.00 loops=1)
        Index Cond: (status = 'completed'::payments_status_enum)
        Index Searches: 1
        Buffers: shared hit=1
Planning Time: 0.122 ms
Execution Time: 0.033 ms
```

The observed plan is an **index scan**, not a sequential scan. It uses
`IDX_payments_status`. The date and source predicates are aggregate `FILTER`
conditions, so they do not narrow the index scan; PostgreSQL must inspect every
completed payment to calculate the all-time total. If completed payments become
most of a large table, PostgreSQL may correctly switch to a sequential scan.
A rollup table or a covering index should be evaluated when production volume
justifies it.

### Timezone and boundary behavior

The application constructs all boundaries with `Date.UTC` and compares them to
the `timestamptz` `created_at` column. Therefore:

- `today` starts at 00:00 UTC.
- the current month is `[first day 00:00 UTC, now]`.
- the previous month is the half-open interval
  `[first day of previous month 00:00 UTC, first day of current month 00:00 UTC)`.
- the quarter begins at 00:00 UTC on January 1, April 1, July 1, or October 1.

On the first day of a month, the previous-month range remains correct because
the upper boundary is exclusive. For example, on July 1 it is
`[June 1 00:00Z, July 1 00:00Z)`.

This is not Cairo-business-time reporting. During UTC+03:00, transactions from
00:00–02:59 Cairo are assigned to the previous UTC day. If financial reporting
must follow `Africa/Cairo`, the reporting timezone must become explicit and
the boundaries converted to UTC before querying.

### Revenue source response growth

The current source enum has three values. The exact serialized
`revenueBySource` object is:

```json
{"lessons":0,"packages":0,"books":0}
```

It is 36 UTF-8 bytes. A ten-source example is 127 bytes, an increase of 91
bytes. Growth is linear in the number and length of source names. The current
schema is fixed to three sources, so additional sources require an enum/query/
DTO change rather than appearing dynamically.

## 2. Query attribution under concurrency

The implementation uses Node.js `AsyncLocalStorage`.

Actual request-context code:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestPerformanceContext {
  requestId: number;
  queryCount: number;
  dbDurationMs: number;
}

export const requestPerformanceStorage =
  new AsyncLocalStorage<RequestPerformanceContext>();

export function recordQueryForCurrentRequest(durationMs: number): void {
  const context = requestPerformanceStorage.getStore();
  if (!context) return;

  context.queryCount++;
  context.dbDurationMs += durationMs;
}
```

The Express middleware creates one context and runs the downstream request
inside it:

```ts
const context = createRequestPerformanceContext();
requestPerformanceStorage.run(context, next);
```

The TypeORM subscriber records the completed query in the currently active
async context:

```ts
public afterQuery(event: AfterQueryEvent<unknown>): void {
  const durationMs = event.executionTime ?? 0;
  const success = event.success;

  recordQueryForCurrentRequest(durationMs);
  performanceMetrics.recordQuery(durationMs, success);
  // structured query logging follows
}
```

TypeORM calls `afterQuery` in the promise chain that executed the query.
`AsyncLocalStorage` propagates the request store through promises, timers, and
I/O callbacks, so concurrent requests do not share the mutable context.
Connection-pool reuse does not change the async context.

A focused test interleaved three delayed query completions across 50 concurrent
contexts. Every context finished with exactly three queries and 6 ms of its own
synthetic DB time; all 50 request IDs were unique.

Incorrect attribution would become possible if a query were deliberately
detached from the request chain and executed later in a global scheduler or an
event handler after the request context ends. Such background queries are
correctly counted globally but are not attributed to the originating HTTP
request.

## 3. `/metrics` security

Before this verification, `/metrics` was public. There was no IP, proxy, or
application-layer protection. This was a real problem.

The endpoint now uses a bearer token because Prometheus and common hosted
scrapers support an `Authorization` header directly, and it works consistently
behind proxies without trusting spoofable client-IP headers.

Actual guard:

```ts
@Injectable()
export class MetricsBearerGuard implements CanActivate {
  public constructor(private readonly configService: ConfigService) {}

  public canActivate(context: ExecutionContext): boolean {
    const configuredToken =
      this.configService.get<string>('METRICS_BEARER_TOKEN');

    if (!configuredToken) {
      throw new ServiceUnavailableException(
        'Metrics endpoint is disabled until METRICS_BEARER_TOKEN is configured',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const suppliedToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';

    if (!this.tokensMatch(suppliedToken, configuredToken)) {
      throw new UnauthorizedException('Invalid metrics bearer token');
    }

    return true;
  }

  private tokensMatch(suppliedToken: string, configuredToken: string): boolean {
    const supplied = Buffer.from(suppliedToken);
    const configured = Buffer.from(configuredToken);

    return (
      supplied.length === configured.length &&
      timingSafeEqual(supplied, configured)
    );
  }
}
```

Runtime evidence:

```text
GET /metrics without Authorization: 401
GET /metrics with configured bearer token: 200
Content-Type: text/plain; charset=utf-8; version=0.0.4
```

If `METRICS_BEARER_TOKEN` is absent, the endpoint fails closed with 503.

## 4. Actual 50-connection load test

Command:

```powershell
node scripts/load-admin-dashboard.cjs
```

Autocannon configuration:

```text
tool: autocannon 8.0.0
connections: 50
total requests: 50
pipelining: 1
route: GET /api/v1/analytics/admin/dashboard
dashboard cache deleted immediately before the run
```

Actual result:

```json
{
  "completed": 50,
  "errors": 0,
  "timeouts": 0,
  "non2xx": 0,
  "statusCounts": {"200": 50},
  "latencyMs": {
    "p50": 431.4063,
    "p95": 473.3661,
    "p99": 474.4747,
    "min": 380.5905,
    "max": 474.4747
  }
}
```

Actual per-request query-count histogram:

```text
backend_http_request_duration_seconds_count{method="GET",route="/api/v1/analytics/admin/dashboard",status="200"} 50
backend_http_db_queries_total{method="GET",route="/api/v1/analytics/admin/dashboard",status="200"} 179
backend_http_db_queries_bucket{method="GET",route="/api/v1/analytics/admin/dashboard",status="200",le="1"} 7
backend_http_db_queries_bucket{method="GET",route="/api/v1/analytics/admin/dashboard",status="200",le="2"} 7
backend_http_db_queries_bucket{method="GET",route="/api/v1/analytics/admin/dashboard",status="200",le="3"} 7
backend_http_db_queries_bucket{method="GET",route="/api/v1/analytics/admin/dashboard",status="200",le="4"} 50
backend_http_db_queries_sum{method="GET",route="/api/v1/analytics/admin/dashboard",status="200"} 179
backend_http_db_queries_count{method="GET",route="/api/v1/analytics/admin/dashboard",status="200"} 50
```

### Frank result: the full endpoint did not remain at three queries

- 43 requests executed four SQL queries.
- 7 requests executed one SQL query.
- `43 × 4 + 7 × 1 = 179`, exactly matching the recorded total.

This distribution is explainable and internally consistent:

- Every request performs one SQL query in `AuthService.validateUser()` from
  `HybridAuthGuard`.
- A dashboard cache miss performs the three parallel dashboard aggregates.
- A dashboard cache hit performs zero dashboard SQL queries.
- Therefore a miss is four total request queries and a hit is one.

There were no 2-query or 3-query full requests, errors, timeouts, or impossible
counts that would suggest cross-request attribution.

The test also exposed a cache stampede: 43 requests observed the empty cache and
recomputed the same three aggregates before the first result populated Redis.
That produced 129 dashboard queries instead of three.

Recommended correction:

1. Add a per-key single-flight promise in-process and a short distributed Redis
   lock if multiple application replicas are used.
2. Cache validated JWT principals by user ID for a short TTL, with invalidation
   on disable/role/status changes, or deliberately accept stateless JWT claims
   until token expiry.
3. Define the query-count SLO explicitly:
   - service cache miss: 3;
   - service cache hit: 0;
   - full endpoint currently: 4 miss / 1 hit.

Claiming that every authenticated request executes exactly three queries would
be inaccurate with the current authentication and caching design.

