# Backend Performance Audit

**Audit timestamp:** 2026-07-09 10:25 UTC  
**Scope:** PostgreSQL, indexes, request latency, query count, response waste, caching, and backend bottlenecks  
**Evidence:** live read-only PostgreSQL statistics, `EXPLAIN (ANALYZE, BUFFERS)`, live Redis statistics, TypeORM SQL logs, static request-path tracing, and 150-request local samples  

> **Remediation update (2026-07-09):** The admin dashboard cold path has
> been reduced from 17 sequential SQL queries to three parallel aggregate
> QueryBuilder calls. Request duration, query count, cumulative DB time,
> response size, TypeORM query timing, structured performance logs, and
> Prometheus metrics are now implemented. The findings below describe the
> pre-remediation baseline.

## Executive conclusion

The database server is not currently the throughput bottleneck. The live database contains only an estimated 288 rows across 54 application tables, has a 99.992% buffer-cache hit ratio, recorded zero deadlocks and zero temporary-file spills, and executed the sampled plans in 0.03–0.15 ms.

The dominant measured cost on the sampled lesson-list request is application-side work: TypeORM query construction/hydration, three SQL round trips, development SQL logging, mapping, and JSON response handling. The endpoint measured p50 14.09 ms, p95 20.79 ms, and p99 29.36 ms locally, versus a no-database HTTP baseline of p50 0.84 ms.

The main scaling risks are:

1. No production-grade query or HTTP latency telemetry.
2. Excessive sequential queries in analytics/dashboard cache misses.
3. Over-fetching in list endpoints.
4. 12 redundant index pairs and 106 non-unique indexes with zero recorded scans.
5. Nine foreign keys without a left-prefix supporting index.
6. Missing composite indexes for repeated multi-column filters.

## Evidence and limitations

- PostgreSQL 18.3 statistics were sampled from the configured `DATABASE_URL`.
- Server uptime at the first sample was approximately 11.85 days.
- PostgreSQL has no `pg_stat_statements`; `track_io_timing` is off. Therefore, historical execution time **per normalized query** does not exist.
- The service has no HTTP timing interceptor, APM, OpenTelemetry, or Prometheus histogram. Production p50/p95/p99 cannot be reconstructed.
- Request latency below is a controlled local measurement against the configured database, not a production traffic distribution.
- Redis hit/miss counters are instance-wide and include cache, queues, and idempotency traffic; they are not endpoint-specific.

## 1. Database performance audit

### Database snapshot

| Metric | Actual value | Interpretation |
|---|---:|---|
| Transactions committed | 41,941 | Cumulative |
| Transactions rolled back | 111 (0.26%) | Low |
| Buffer hits | 13,858,407 | Almost all reads served from memory |
| Physical block reads | 1,089 | 0.008% of buffer accesses |
| Buffer-cache hit ratio | **99.992%** | Excellent |
| Temporary files / bytes | **0 / 0** | No observed sort/hash spills |
| Deadlocks | **0** | No recorded deadlock problem |
| Blocked sessions at sample | **0** | No active blocking |
| Active DB time / session time | **0.074%** | Database is mostly idle |
| DB round-trip p50 / p95 / p99 | **0.090 / 0.138 / 0.225 ms** | Local 20-query sample |

### Representative query plans

| Query shape | Execution | Plan | Optimal now? |
|---|---:|---|---|
| Count active students | 0.043 ms | Sequential scan, 17 rows | Yes; table is too small for an index scan |
| Count approved students | 0.030 ms | Sequential scan, 17 rows | Yes now; composite/partial index will matter at scale |
| Lesson list + teacher + subject | 0.148 ms | Sequential lesson scan, nested joins, PK lookup | Yes for current size |
| Exam attempts by exam + state | 0.068 ms | Sequential scan, 7 rows | Yes now; composite index is a scale requirement |
| Lesson completion count | 0.037 ms | `lesson_id` index scan | Yes |

The current sequential scans are mostly planner-optimal because the tables fit in one or two heap pages. Treat them as future scaling signals, not present incidents.

### Heavy tables / high I/O

| Table | Physical blocks | Cached hits | Sequential rows read | Live rows | Finding |
|---|---:|---:|---:|---:|---|
| `users` | 39 | 40,264 | 79,282 | 17 | Highest logical I/O; dashboard counts repeatedly scan it |
| `questions` | 20 | 4,158 | 11,019 | 25 | Second-highest scan volume |
| `lessons` | 13 | 16,484 | 9,156 | 5 | List/load tests and joins dominate |
| `student_profiles` | 16 | 1,366 | 2,538 | 6 | Small now; no current physical-I/O issue |
| `user_sessions` | 13 | 1,591 | 621 | 95 | Largest live-row table |

No table is physically heavy today; the largest listed relation is only 262 KB.

### Deadlocks and synchronization

- Zero cumulative deadlocks.
- Zero blocked sessions at the sample.
- No active long-running queries at the sample.
- Cumulative idle-in-transaction time is 37.2 seconds. This is not currently material, but transaction duration should be included in future telemetry.

### Statistics

- Autovacuum and auto-analyze are enabled.
- Default statistics target is 100.
- 17 populated tables have never been analyzed.
- `users`, `questions`, `exams`, `exam_attempts`, and `user_sessions` have recent auto-analyze timestamps.
- At the current tiny cardinalities, stale statistics have negligible measured impact. Run `ANALYZE` after bulk imports and before scale/load tests.

### Missing database observability

`pg_stat_statements` is absent and `track_io_timing` is off. This is the largest audit blind spot: historical total time, mean time, calls, rows, block reads, and temp use per normalized query are unavailable.

## 2. Indexing deep dive

### Current inventory and use

| Metric | Actual value |
|---|---:|
| Total indexes | 260 |
| Indexes with at least one scan | 99 (38.1%) |
| Zero-scan indexes | 161 (61.9%) |
| Zero-scan, non-unique indexes | 106 (40.8% of all indexes) |
| Total index size | 3.09 MiB |
| Zero-scan, non-unique size | 1.19 MiB (38.4%) |

Most-used indexes include:

| Index | Scans |
|---|---:|
| `IDX_lesson_packages_status` | 2,215 |
| `IDX_lesson_package_items_package_id` | 1,889 |
| `teacher_subjects(teacher_profile_id)` | 1,525 |
| `teacher_profiles` primary key | 515 |
| `IDX_lessons_teacher_id` | 503 |
| `subjects` primary key | 442 |
| `lessons` primary key | 427 |
| `exam_attempts` primary key | 349 |
| `IDX_users_status` | 344 |
| `IDX_exam_attempts_exam_id` | 207 |
| `IDX_users_role` | 177 |

Zero scans do **not** prove an index is removable, especially for constraints, rare admin operations, or a small dataset. Remove only after a representative production observation window.

### Proven redundant index pairs

Twelve pairs cover identical column sequences:

- `attendance_codes(code)`
- `discount_codes(code)`
- `notification_settings(user_id)`
- `payments(idempotency_key)`
- `rank_tiers(slug)`
- `student_game_profiles(user_id)`
- `student_profiles(user_id)`
- `teacher_profiles(user_id)`
- `uploaded_files(filename)`
- `users(email)`
- `users(phone)`
- `users(username)`

In each case, retain the unique constraint-backed index and remove the redundant explicit index after verifying migration ownership. This removes 12 indexes, or **4.6% of the inventory**, and avoids duplicate write maintenance. Present read-latency impact is approximately 0%; the benefit is lower write amplification and storage as the tables grow.

### Foreign keys without a left-prefix supporting index

Nine foreign keys lack a supporting index:

- `attendance_code_audits(actor_id)`
- `attendance_codes(used_by)`
- `attendance_codes(created_by)`
- `attendance_records(marked_by)`
- `complaints(admin_id)`
- `lesson_progress(lesson_id)`
- `omr_sheets(attempt_id)`
- `omr_sheets(teacher_id)`
- `student_game_profiles(rank_tier_id)`

Priority should follow delete/update frequency on the parent and lookup frequency on the child. The most likely critical additions are `lesson_progress(lesson_id)`, `omr_sheets(attempt_id)`, and `omr_sheets(teacher_id)`.

### Composite-index opportunities

Add only after `pg_stat_statements` confirms frequency:

1. `users(role, status) WHERE deleted_at IS NULL`  
   Supports six repeated dashboard counts. Better still, collapse the six counts into one conditional-aggregate query.

2. `exam_attempts(exam_id, state)`  
   Repeated throughout exam analytics and reports. Current separate indexes cannot filter both columns in one ordered lookup.

3. `lesson_sessions(lesson_id, video_progress_percent)`  
   Supports per-lesson completion counts.

4. `lesson_purchases(lesson_id, created_at)`  
   Supports lesson analytics and date-bounded revenue.

5. `lessons(teacher_id, created_at) WHERE deleted_at IS NULL` and/or `lessons(subject_id, created_at) WHERE deleted_at IS NULL`  
   Matches common filters plus default sort.

6. `users(role, created_at) WHERE deleted_at IS NULL`  
   Supports date-bounded platform reports.

## 3. Request-level performance

### Measured latency distribution

150 sequential requests per route, after 10 warmups:

| Route | Response | p50 | p95 | p99 | Mean | Max |
|---|---:|---:|---:|---:|---:|---:|
| `GET /` baseline | 137 B | 0.842 ms | 1.695 ms | 2.653 ms | 0.920 ms | 3.672 ms |
| `GET /api/v1/lessons` | 3,224 B | **14.088 ms** | **20.785 ms** | **29.359 ms** | 14.605 ms | 31.106 ms |

The lesson endpoint is 16.7× the p50 baseline. These measurements include development-mode SQL logging, so they should not be labeled production SLOs.

### Queries per request

| Request path | SQL queries on a cache miss | Execution pattern |
|---|---:|---|
| Lesson list | **3 actual logged queries** | Count, distinct-ID pagination, full entity fetch |
| Admin dashboard | **17** | Sequential |
| Teacher dashboard | **8** | Sequential |
| Student dashboard | **7** | Sequential |
| Lesson analytics | **10** | Sequential |
| Exam analytics | Up to **9** | Sequential |
| Teacher report | **12** | Four parallel groups; queries sequential inside groups |
| Student progress report | **4** | Mostly sequential |
| Platform report | **17** | Four parallel groups |

The admin dashboard’s 17 sequential queries are the clearest request-speed defect. On a cache miss, reducing 17 round trips to three aggregate queries cuts database round trips by **82.4%**. At the measured local p50 RTT this saves only about 1.25 ms; at a realistic 5 ms app-to-database RTT it saves about 70 ms.

### Data fetched versus used

The lesson list selects full `Lesson`, `User`, and `Subject` entities:

- Approximately 57 selected columns per joined row.
- Approximately 33 fields are used in the response mapping.
- Column-level over-fetch is therefore approximately **42%**.
- The teacher join fetches roughly 22 columns but uses four: approximately **82% teacher-column waste**.
- The subject join fetches roughly eight columns but uses three: approximately **63% subject-column waste**.

Use an explicit projection for list responses. Do not fetch authentication/profile/session fields from the teacher row for a public lesson card.

Exam analytics selects only three answer columns and uses all three, but loads every graded answer into Node.js and aggregates in memory. Move this `GROUP BY exam_question_id` aggregation to PostgreSQL to prevent memory and serialization cost growing with attempts × questions.

### Serialization overhead

The measured lesson payload is only 3.2 KB, so serialization is not a present bottleneck. Exact serialization time is not instrumented. The larger issue is ORM hydration and materializing unused columns before serialization. Response compression is not configured; add it when typical JSON responses become materially larger than this sample.

## 4. Bottleneck allocation

For the measured `GET /api/v1/lessons` p50 of 14.088 ms:

| Component | Estimated share | Basis |
|---|---:|---|
| Baseline HTTP/network/framework | **6%** | 0.842 ms baseline |
| PostgreSQL execution + three local DB round trips | **≤6%** | Plans below 0.15 ms; DB RTT p50 0.09 ms |
| TypeORM construction/hydration, SQL logging, mapping, serialization | **≈88%** | Residual measured time |
| External calls | **0%** | None on this route |

This percentage applies only to the controlled sampled route. A backend-wide or production percentage cannot be derived because HTTP histograms and query timing telemetry do not exist.

Other findings:

- EasyKash, Bunny, and Bunny Storage `fetch()` calls have no explicit timeout/abort signal. They can dominate the routes that call them, but no timing data exists to assign a percentage.
- Redis reports 83,212 hits and 142,726 misses: a **36.8% global hit rate**, with zero evictions and 293 current keys. Because the instance also serves BullMQ and idempotency, this is not a clean application-cache hit rate.
- Analytics/report caches use five- or ten-minute TTLs. They can make hot reads cheap, but cache hit/miss and compute duration are not measured.

## 5. Prioritized performance work

Scores: impact and frequency are 1–5 (higher is more important); effort is 1–5 (higher is harder).

| Rank | Problem | Impact | Frequency | Effort | Quantified effect |
|---:|---|---:|---:|---:|---|
| 1 | Missing HTTP/query/cache telemetry | 5 | 5 | 2 | Blocks production p50/p95/p99 and per-query attribution |
| 2 | Admin analytics cache miss: 17 sequential queries | 4 | 3 | 2 | **82.4% fewer DB round trips** if collapsed to three aggregates |
| 3 | Lesson list: three queries and ~42% column over-fetch | 4 | 5 | 2 | Target 3→2 queries and ~42% fewer selected fields |
| 4 | Analytics/report query fan-out | 4 | 3 | 3 | 7–17 queries per cold request |
| 5 | 12 duplicate indexes | 2 now / 4 at scale | Write-dependent | 2 | **4.6% fewer indexes**, less write amplification |
| 6 | Nine unindexed foreign keys | 2 now / 4 at scale | Write/delete-dependent | 2 | Prevents child scans and parent delete/update stalls |
| 7 | Missing composite indexes | 1 now / 4 at scale | Query-dependent | 2 | Current plans already under 0.15 ms; validate after growth |
| 8 | Unbounded external calls without timeouts | 4 | Route-dependent | 1 | Prevents external latency from consuming the whole request budget |

## Quick fix

Refactor `getAdminDashboard()` so the six user counts come from one `COUNT(*) FILTER (...)` query, the two content counts run together, and all three revenue periods are returned by one conditional aggregate per purchase source. Run the independent aggregates with `Promise.all`.

Expected impact:

- SQL queries: 17 → approximately 3–5.
- DB round trips: **70.6–82.4% reduction**.
- At 5 ms DB RTT: approximately **60–70 ms lower cache-miss latency**.
- Low implementation effort and no API contract change.

The second quick win is a projected lesson-list query that selects only response fields. It directly removes approximately **42% of selected joined columns** and avoids hydrating unused teacher/subject properties.

## Measurement plan required for a production-grade follow-up

1. Enable `pg_stat_statements` and `track_io_timing`; collect at least seven representative days.
2. Add an HTTP interceptor that records route template, status, total duration, SQL query count/time, serialization time, response bytes, cache hit/miss, and external-call duration.
3. Emit histograms for request p50/p95/p99 and counters for queries per route.
4. Add explicit timeouts to EasyKash, Bunny, storage, SMTP, Twilio, and Firebase calls.
5. Re-run index usage analysis after the observation window before dropping zero-scan indexes.
