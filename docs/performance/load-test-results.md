# Load-test results and findings (living document)

Plan: `C:\Users\DELL.SXT602\.claude\plans\pasted-content-id-e26f-learnix-full-pla-functional-flamingo.md` (PERF-01…24).
Stack and how to run it: `learnix-infra/loadtest/README.md`.

**Status: Phase 0 (foundation) is done and verified for the S profile. No latency, throughput or EXPLAIN number has
been measured yet. Nothing in this file is a benchmark result.**

Baseline commit: `c91dc23` (image `learnix-api:loadtest` built from it). Postgres 16.15 (Debian), Redis 7.

## Phase 0 outcomes

| Item                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Schema parity (PERF-20)               | **Corrected.** The migration chain _does_ build from an empty database: 156 of 156 applied, ~41 s via `npm run test:migrations`, ~4–5 s via `loadtest:db:build`. The comment in `test/global-setup-e2e.ts` ("the migration chain fails on an empty database") is stale. The load DB is built from migrations, so it carries the 641 public indexes production has, not the entity-only set `synchronize` produces. | `scripts/migration-chain-test.ts` run; `loadtest:db:build` output |
| Entity/migration drift                | The chain test reports **750 drift statements** (baseline-tolerated) between the migrated schema and the entities. Not investigated here; relevant to any "does the entity match prod" claim.                                                                                                                                                                                                                      | chain test output                                                 |
| Container sizing                      | api and worker 0.5 vCPU / 1 GiB; Postgres 2 vCPU / 2 GiB; Redis 1 vCPU / 512 MiB `noeviction`. Idle api RSS ≈ 234 MiB, worker ≈ 230 MiB.                                                                                                                                                                                                                                                                           | `docker inspect`, `docker stats`                                  |
| `/metrics`                            | 401 without the bearer token, Prometheus text with it.                                                                                                                                                                                                                                                                                                                                                             | curl                                                              |
| Seed S validated through the real API | Login (CSRF flow) as admin and student; student dashboard `purchasedLessons=30, activeAccessCount=30` (3 packages × 10 lessons); owned lesson progress → 200, non-owned lesson → 403; admin dashboard `paidOrders=153, grossSales>0, activeLearners=57`.                                                                                                                                                           | curl against `:3001`                                              |

## Fidelity deltas versus production (read before comparing any number)

1. **`NODE_ENV=development`, `APP_ENV=development`.** `NODE_ENV=production` makes auth cookies `Secure`, which k6 will not
   send back over `http://localhost`. Consequences: no CSP, Swagger on, stack traces in error bodies, no Redis
   reconnect strategy, `TYPEORM_LOGGING=false` set explicitly (it defaults to on outside production). `NODE_ENV=test`
   was rejected because it **removes the global ThrottlerGuard** (`app.module.ts:402`), hiding a per-request Redis
   round trip.
2. **Postgres presents a self-signed certificate** and the app runs with `SSL_REJECT_UNAUTHORIZED=false`. The app
   forces SSL for every non-loopback host and has no override (`common/utils/database-ssl.util.ts`); TLS on is
   closer to RDS (`rds.force_ssl`).
3. **Docker-on-Windows CPU/IO**, not Fargate/gp3/t4g-burst. Absolute numbers will not transfer; relative changes
   between runs will.
4. **Lesson access expiry** is seeded 30–90 days ahead. The real flow expires access after `lessons.available_for_days`
   (default 7), which would lock every student out mid-run.
5. **Payments, email, SMS, push, WhatsApp, meetings** have no credentials in `loadtest.env`; payment write scenarios
   stay disabled until an EasyKash stub exists.

## Seed-shape findings (the seed first looked right and was not)

Row counts matched the profile and the app still disagreed. Each of these changed what a measurement would have meant:

- **A purchasable package needs a locked course version.** `payment-finalization.service.ts` refuses a package without
  `current_version_id` and copies the live curriculum into `course_version_items`. Without them, access checks and
  `package_purchases.course_version_id` are wrong.
- **A package purchase fans out to one `lesson_purchases` row per lesson.** The student dashboard counts
  `lesson_purchases`, not entitlements or `package_purchases` (`analytics/analytics.service.ts:436-483`); it showed
  `purchasedLessons: 0` for a student with three entitlements. `lesson_purchases` will be the largest enrollment table
  (M ≈ 2M rows, L ≈ 10M).
- **The settled-order predicate needs `orders.paid_at` and `orders.payment_id` → a completed payment**
  (`common/metrics/product-financial-metrics.service.ts:30-37`). With both null, admin revenue was empty.
- **`users.finance_permissions` defaults to every finance permission**, so non-admin rows must set `'[]'` explicitly.
- **`activeLearners` is fed by `lesson_sessions`**, written by the watch lifecycle (`POST /lessons/:id/enter`, `PATCH /lessons/sessions/:sessionId/progress`, `POST /lessons/:id/exit`), not by `POST /student/lessons/:id/progress` (that writes `lesson_progress`).
- `GET /student/lessons` returns attendance-style data (empty for purchasers); browse journeys should use
  `GET /packages` and `GET /student/lessons/my/progress`.

## New index candidate from Phase 0 (not yet proven)

- **IDX-09** `lesson_sessions(entered_at)`: the admin dashboard filters `entered_at >= $1 AND entered_at < $2` with no
  student predicate (`analytics/admin-dashboard.service.ts:257-261`); the existing indexes all lead with `student_id`.
  Validate with `EXPLAIN (ANALYZE, BUFFERS)` on the M profile before adding anything.
  **Update: not supported.** EXPLAIN on M shows the 30-day window covers about 27 % of the table, so a seq scan is
  chosen with or without the index (see "EXPLAIN on the M database"). Replaced by the lesson_purchases candidate there.

## Phase 0b: k6 harness (verified)

Files: `learnix-infra/loadtest/{lib,journeys,scenarios,collect}`. Run from `learnix-infra/loadtest`:
`node collect/run.mjs scenarios/smoke.js --run-id=<name>` (wraps k6 and collects server-side evidence into `results/<name>/`).

| Check                      | Result                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target guard               | `api.learnix.school`, `learnix.school`, `example.com` refused (exit 107, no request sent). The staging CloudFront host is refused without `-e CONFIRM_TARGET=<host>`.                                                                   |
| Smoke (A)                  | 34 requests, **33 of 33 checks pass, 0 % failed**, student + teacher + admin journeys, login, token refresh and a post-refresh authenticated call. Ran clean back to back (run ids smoke-5, smoke-6, smoke-7).                          |
| Evidence collected per run | k6 summary; every 5 s container CPU/mem, Postgres connection states and lock waits, Redis memory, api gauges; per-route server-side count / avg ms / **avg SQL queries per request** (delta over the run); top 30 `pg_stat_statements`. |

Two harness bugs were found by the smoke run and fixed in the harness (not the app): `POST /student/lessons/:id/progress`
returns 201, not 200; and lessons need `duration` seeded or progress writes return 400 ("Lesson duration is not available
yet").

### Throttling shapes the whole test design (read before designing any load)

All limits are per client IP, kept in Redis (`common/constants.ts`, `common/throttle/login-throttle.ts`):

| Route class          | Limit                                                                                                                                   | Source                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Every route (global) | 300 req / min / IP, hard-coded, no env override                                                                                         | `THROTTLE.GLOBAL`        |
| `POST /auth/login`   | **5 per 5 min / IP in production**, pinned (no env can raise it). Outside production `LOGIN_THROTTLE_LIMIT` may raise it, capped at 200 | `resolveLoginThrottle`   |
| `POST /auth/refresh` | **5 per min / IP** (`THROTTLE.DEFAULT`)                                                                                                 | `auth.controller.ts:182` |

A single k6 host would be throttled after about 5 req/s, so on a LOCAL target each VU presents its own address through
`X-Forwarded-For` (the api trusts one proxy hop, `TRUST_PROXY_HOPS`; Express uses the last entry). No limit is relaxed.
`CLIENT_IPS=shared` puts every VU behind one address on purpose. The header is never sent to non-local targets.

**Hypothesis (S) to test, production-relevant:** students behind one school or carrier NAT share an IP, so a class
logging in together is capped at 5 logins per 5 minutes and 5 refreshes per minute for the _whole_ NAT. The `shared`
mode of the harness reproduces exactly this; it belongs in the spike scenario (class start). Not yet run.

### First signals (idle stack, single VU, n = 1 to 12 per route: **not a benchmark**)

Server-side averages from `results/smoke-6/routes.json`:

| Route                            | Avg ms | SQL / req | n   |
| -------------------------------- | ------ | --------- | --- |
| POST /auth/login                 | 1060   | 4         | 3   |
| POST /auth/refresh               | 996    | 5         | 1   |
| GET /reports/teacher/summary     | 215    | 15        | 1   |
| GET /analytics/teacher/dashboard | 94     | 5         | 1   |
| GET /reports/admin/platform      | 65     | 12        | 1   |

Login and refresh take about 1 s on a 0.5 vCPU container while the other routes sit far below that, consistent with PERF-03
(bcryptjs at cost 12; refresh does a hash and a compare). Whether concurrent logins starve other requests is a Phase 2
question (needs a concurrency scenario and event-loop delay).

## Baseline (run `baseline-3`, M profile, local stack, commit c91dc23 + uncommitted harness)

Setup: M seed (20k students, 50 teachers, 2.0M `lesson_purchases`, 1.0M `lesson_sessions`, 100k orders), api 0.5 vCPU / 1 GiB, worker alongside, Postgres 2 CPU / 2 GiB. Redis flushed first, `pg_stat_statements` reset at start. Arrival rate: 60 student, 6 teacher, 3 admin iterations per minute; 3 min ramp (tagged `warmup`, excluded) then 10 min steady. Student mix browse 40 % / learn 40 % / dashboard 20 %. Raw evidence: `learnix-infra/loadtest/results/baseline-3/` (gitignored).

**Validity.** 4,065 requests, 0 failed, 4,064/4,064 checks, 0 dropped iterations. The k6 process CPU was **not** recorded (the collector does not sample it); at about 5 req/s the generator is very unlikely to be the limit, but that is an assumption, not a measurement. An earlier run (`baseline-2`) was thrown away: k6 clears the cookie jar between iterations and the harness kept its "already logged in" state, so 43 % of requests were 401/403. That was a harness bug, fixed with `noCookiesReset` plus a session refresh at 10 min.

**Read the next two sections before using this table:** its steady phase includes a synchronised refresh wave (a harness artefact), which inflates several rows; the auth-free recomputation is in "Event-loop stalls and the auth burst".

**Small samples.** Teacher endpoints have n = 68 and admin endpoints n = 34 in the steady phase, so their p95 is close to the second-highest observation. Treat them as indicative until a longer or higher-rate run repeats them.

### Steady-state latency (client side, ms) against the PROPOSED limits

| Endpoint | p50 | p95 | p99 | Limit p95 | Result |
|---|---:|---:|---:|---:|---|
| auth.refresh (n = 37) | 1187 | 2276 | 2643 | 1500 | **MISS** |
| teacher.report.summary | 1531 | 1837 | 2273 | 1000 | **MISS** |
| admin.dashboard | 898 | 1123 | 1298 | 2000 | ok |
| teacher.dashboard | 69 | 1064 | 1319 | 1000 | **MISS** |
| admin.report.platform | 593 | 693 | 877 | 2000 | ok |
| lesson.session.progress | 14 | 495 | 1270 | 300 | **MISS** |
| teacher.students.list | 323 | 472 | 1058 | 500 | ok |
| packages.detail | 9 | 451 | 1127 | 400 | **MISS** |
| subjects.list | 10 | 425 | 1065 | 500 | ok |
| student.dashboard | 13 | 414 | 1948 | 500 | ok |
| packages.list | 11 | 136 | 985 | 500 | ok |
| search.all | 12 | 194 | 376 | 500 | ok |
| other 11 endpoints | 2 to 112 | 26 to 244 | 30 to 565 | | ok |

`auth.login` has no steady-state sample: every login happened inside the warm-up window by design.

### Server side (from `/metrics`, whole run including warm-up)

| Route | calls | avg server ms | avg SQL / request |
|---|---:|---:|---:|
| POST /auth/refresh | 37 | 1445 | 5 |
| POST /auth/login | 37 | 1419 | 4 |
| GET /reports/teacher/summary | 68 | 1286 | 15 |
| GET /analytics/admin/dashboard | 34 | 957 | 12 |
| GET /reports/admin/platform | 34 | 623 | 12 |
| GET /teacher/students | 68 | 364 | 8 |
| GET /analytics/teacher/dashboard | 68 | 159 | 5 |
| PATCH /lessons/sessions/:id/progress | 771 | 83 | 7 |
| POST /student/lessons/:id/progress | 257 | 59 | 9 |
| POST /lessons/:id/exit | 257 | 54 | 9.2 |
| POST /lessons/:id/enter | 257 | 59 | 7 |
| GET /search | 75 | 30 | 12.2 |
| public catalogue (packages, teachers, subjects) | about 300 each | 36 to 62 | 1 to 2.6 |

Resources: api CPU peaked at 55 % of a core (quota is 50 %), 11 % average in steady state, RSS 288 MB at the end. Postgres peaked at 198 % of 2 CPUs and averaged 24 % in steady state. Redis 8 MB. Event-loop lag gauge: see the correction in "Event-loop stalls and the auth burst" (the 1.48 s maximum is a process-lifetime value, not a baseline measurement).

### What the data supports and what it does not

- **PERF-03 (bcrypt, refresh under lock): supported, not isolated.** Login and refresh each average about 1.4 s server-side at 4 to 5 queries, on a nearly idle API. That is consistent with bcrypt at 12 rounds on 0.5 vCPU, but I did not run a profile or a no-bcrypt control, so the split between bcrypt time and lock/pool wait is unproven. A burst test (scenario K) is needed to show the starvation effect that the 40 s dry run hinted at (login bursts delayed unrelated requests).
- **Tail latency on cheap endpoints: explained by auth traffic** (see "Event-loop stalls and the auth burst"). Stalls occur only while logins or refreshes run; the heartbeat and catalogue misses above disappear when the refresh wave is excluded.
- **Heartbeat write path:** `PATCH .../progress` costs 7 queries per call and is the highest-volume route (771 calls). Its p95 is 101 ms when no auth request is active, so the 495 ms miss above came from the refresh wave. Not yet load-tested at realistic concurrency.
- **Search** issues 12.2 queries per call (matches the code reading) but is cheap on this dataset (30 ms avg).
- **Teacher and admin reports** are the slow reads, and the cost sits in a handful of statements (below).

### Top statements (`pg_stat_statements`, reset at run start)

| Rank | Statement (shortened) | calls | mean ms | total s |
|---:|---|---:|---:|---:|
| 1 | teacher summary CTE `live` over `lesson_purchases` join `lessons` | 68 | 960 | 65.3 |
| 2 | `COUNT(DISTINCT lp.student_id)` for a teacher's lessons | 68 | 679 | 46.2 |
| 3 | admin `session_window` CTE over `lesson_sessions` | 34 | 831 | 28.2 |
| 4 | another `COUNT(DISTINCT lp.student_id)` variant | 68 | 405 | 27.6 |
| 5 | admin `current_orders` revenue CTE | 34 | 732 | 24.9 |
| 6 | teacher `COUNT(DISTINCT ls.id)` over `lesson_sessions` | 68 | 316 | 21.5 |
| 7 to 10 | admin dashboard `lesson_sessions` aggregates by `entered_at` | 34 each | 474 to 548 | 16 to 19 |

The first four are one family: distinct-student counts through `lesson_purchases`.

## EXPLAIN on the M database (manual, warm cache unless noted)

**1. Teacher "distinct students" count (`lesson_purchases` join `lessons`, 200 lessons, 28.6k matching rows of 2.0M).**
Plan: `Parallel Seq Scan on lesson_purchases`, about 200 ms, about 36k buffers. My psql variable setup returned the same teacher id for the "whale" and "small" probes, so the whale-versus-small contrast is **not** tested. The query has no `revoked_at IS NULL` predicate, so the existing partial index `IDX_lesson_purchases_lesson_student_live` cannot serve it, and the plain `IDX_lesson_purchases_lesson_id` would need a heap fetch per row, which the planner declined.
Trial inside a rolled-back transaction: a **non-partial `(lesson_id, student_id)` index** gave a nested loop with index-only scans, **9 ms** (about 22x faster, 4.9k buffers). Nothing was kept. This is a candidate (call it IDX-10), not an applied change. Open before adding it: write cost on a 2.0M-row table written on every purchase, size (the heap is 284 MB), and whether the app really wants revoked rows counted here (a semantic question; I did not change the query).

**2. Admin dashboard `lesson_sessions` aggregate over the default 30-day window (`entered_at`).**
`Parallel Seq Scan`, 13.4k buffers, **36 ms** warm, with or without an `entered_at` index: the 30-day window covers about 27 % of the table, so the planner correctly keeps the scan. **IDX-09 is therefore not supported at this data density and is withdrawn as a recommendation.** The unexplained part: the same statements averaged 474 to 548 ms inside the baseline. Candidates are cold buffers, six dashboard queries running in parallel on a 2-CPU database, or a different plan with the real bind values. I have not determined which, so do not read this as a DB-CPU conclusion.

## Event-loop stalls and the auth burst (runs `baseline-4`, `auth-burst-2`, `auth-burst-3-refresh`, `auth-burst-4-refresh-pg`)

### Corrections to the baseline section above (read first)

- **The "event-loop lag max 1.48 s" figure is not a baseline measurement.** `backend_nodejs_eventloop_lag_max_seconds` comes from a `monitorEventLoopDelay` histogram that is never reset (`observability/performance-metrics.registry.ts:85`), so it is the maximum since the process started. The api had been up since 13:42Z, across two earlier runs. It cannot say when a stall happened, or whether a run caused it. Prefer the timestamped probe below. (Making that gauge resettable or windowed is a small observability improvement worth considering, but it is a production change and is not done.)
- **The steady-state misses in `baseline-3` are mostly a harness artefact.** Every VU logs in during warm-up and refreshes once, all at about the same moment 10 minutes later, so the "steady" phase contains a synchronised refresh wave. With that wave excluded (table below), the endpoints reported as misses for `lesson.session.progress` (495 ms) and `packages.detail` (451 ms) are at 101 ms and 59 ms p95. A real fleet's refreshes would be spread out, but they would not be zero (see the extrapolation, which is an assumption, not a measurement).
- **Two instrument bugs found and fixed while doing this** (neither affected the latency numbers from k6, but both affected the server-side evidence): (1) the Postgres state sampler in `collect/run.mjs` used `GROUP BY 1` over an aggregate and failed silently in every run before `auth-burst-4`, so no pool or lock-wait data existed until now; (2) the first probe awaited each response before scheduling the next, so the samples *after* a stall looked "late" and were discarded as probe noise (in `baseline-4`, 220 of 1,778 samples, which hides part of the stalls; stall counts for that run are lower bounds). The probe now fires on a fixed grid in its own process.

### Method

`collect/probe.mjs` (own process) sends `GET /api/v1/health` every 200 ms and scrapes the api's CPU seconds every 2 s. `collect/analyze-stalls.mjs` joins the probe with k6's per-request JSON points: a stall is a probe round-trip above max(100 ms, 10x the median); "in flight" means the k6 request's interval overlaps the stall window. `collect/clean-window.mjs` recomputes per-endpoint latency over the part of a run with no auth request active. The api CPU reading is the delta of `process_cpu_seconds_total` over wall time, as a fraction of the 0.5 vCPU quota; readings above 100% (up to 157%) are scrape-timing misalignment, because the Docker quota is enforced (`NanoCpus=500000000`), so treat CPU figures as approximate.

### Where the stalls are (`baseline-4`, same load as `baseline-3`)

- 31 stall episodes (peak probe round-trip 2.6 to 3.1 s). 28 of them overlap login or refresh requests, 2 overlap heavy report requests (`teacher.report.summary` 1.9 s, `admin.dashboard`), 1 is unidentified.
- **They are confined to two time windows**: 0 to 180 s (the warm-up logins) and 630 to 720 s (the refresh wave). Between 180 s and 630 s, 450 s with no auth request, the probe's worst round-trip was 170 ms (one sample) and its median stayed at 4 ms.
- Overlap is not proof of cause by itself, because slow requests overlap everything and the auth requests are also victims of the stall. The evidence that makes this more than correlation is the 450 s auth-free window with no stalls and the controlled experiment below.

### Per-endpoint latency with no auth request active (`baseline-4`, 496 s window, 2,799 requests)

| Endpoint | n | p50 | p95 | p99 | Limit p95 | Result |
|---|---:|---:|---:|---:|---:|---|
| teacher.report.summary | 49 | 1637 | 2414 | 2844 | 1000 | **MISS** (n<50) |
| admin.dashboard | 24 | 996 | 1250 | 1604 | 2000 | ok (n<50) |
| teacher.students.list | 49 | 373 | 886 | 900 | 500 | **MISS** (n<50) |
| admin.report.platform | 24 | 652 | 806 | 912 | 2000 | ok (n<50) |
| teacher.dashboard | 49 | 61 | 422 | 726 | 1000 | ok (n<50) |
| lesson.session.progress | 568 | 15 | 101 | 212 | 300 | ok |
| lesson.progress.write | 190 | 11 | 102 | 200 | 500 | ok |
| search.all | 65 | 11 | 99 | 214 | 500 | ok |
| packages.detail | 206 | 9 | 59 | 162 | 400 | ok |
| student.dashboard | 93 | 13 | 55 | 358 | 500 | ok |
| packages.list | 207 | 11 | 35 | 146 | 500 | ok |
| all other student/notification endpoints | 93 to 207 | 5 to 15 | 16 to 94 | 100 to 294 | | ok |

Without auth traffic, the only genuine misses at this load are the **teacher reports** (summary 2.4 s, students list 886 ms), and both have small samples. They match the top `pg_stat_statements` rows (distinct-student counts through `lesson_purchases`, see IDX-10 above). The student-facing paths are healthy at this rate.

### Controlled experiment: scenario K (`scenarios/auth-burst.js`)

Setup: a victim stream of 5 req/s to two cheap public GETs (no login needed, so slowdown there is starvation, not their own cost) runs while logins arrive at stepped rates, each login a different student from a fresh client address (the per-IP throttle is not what is measured). 45 s quiet, four 60 s stages, 45 s quiet. api 0.5 vCPU, M dataset. `MODE=refresh` adds a `POST /auth/refresh` after each login.

**Login only (`auth-burst-2`), victim latency in ms:**

| Stage | logins | victim p50 | p90 | p95 | max | login p50 |
|---|---:|---:|---:|---:|---:|---:|
| quiet before | 0 | 5 | 6 | 8 | 122 | |
| 15 /min | 14 | 5 | 523 | 599 | 1108 | 1053 |
| 30 /min | 29 | 80 | 574 | 614 | 672 | 1045 |
| 45 /min | 45 | 412 | 592 | 632 | 855 | 1067 |
| 60 /min | 59 | **2327** | 3396 | 3698 | 4432 | **8143** |
| quiet after | 22 | **2410** | 5203 | 7098 | 9396 | 9668 |

**Login plus refresh per iteration (`auth-burst-3-refresh`; each iteration is 2 bcrypt operations):**

| Stage | iterations | victim p50 | p90 | p95 | login p50 | refresh p50 |
|---|---:|---:|---:|---:|---:|---:|
| 15 /min | 14 | 24 | 523 | 597 | 1053 | 1087 |
| 30 /min | 29 | 1316 | 2169 | 2348 | 4589 | 4792 |
| 45 /min | 43 | 4502 | 11682 | 15859 | 15715 | 17473 |
| 60 /min | 47 | 6548 | 27356 | 31704 | 25524 | 24320 |
| quiet after | 21 | 17008 | 24707 | 26465 | 27803 | 14856 |

(An earlier, harsher run, `auth-burst-1` at 1, 2 and 4 logins per second, reached victim p95 of 18 s and left victim p50 at 41 s after the burst ended while the backlog drained. It was only used to choose the gentler rates above.)

What this shows, on this stack:

1. **A login costs about 1.05 s of wall time on the 0.5 vCPU api and a refresh the same** (1053 vs 1087 ms at 15/min). Server-side averages in `baseline-3` agree (1.42 s and 1.45 s under mixed load).
2. **Throughput ceiling is roughly 45 to 60 logins or refreshes per minute (about 1 per second; each is two bcrypt operations).** Login-only collapsed between 45 and 60 per minute; login+refresh (2 operations per iteration) collapsed between 15 and 30 iterations per minute. These two agree, which is the evidence for a shared cost and a shared ceiling.
3. **Above the ceiling there is no graceful degradation**: latency goes from about 1 s to 8 s to 25 s within a stage, and the backlog outlives the burst (victim p50 still 2.4 s to 17 s in the quiet period afterwards). `dropped_iterations` was 26 (login only) and 292 (login+refresh): arrivals k6 could not start because the api had fallen behind.
4. **Below the ceiling, unrelated requests are still hurt.** From 15 logins per minute, the victim's p90 is already about 520 ms against 6 ms in the quiet control: roughly the slowest tenth of unrelated requests wait behind a login.
5. **The bottleneck is CPU/event loop, not the DB pool.** In `auth-burst-4-refresh-pg` (the first run with working Postgres sampling): at most 2 `active` connections, 0 lock waits, and up to 6 connections `idle in transaction` at the same time, with 15 total connections across api and worker. That is the PERF-03 mechanism in action (transactions held open while bcrypt computes), but the pool of 10 per process was not exhausted in this run, and no row-lock contention occurred because every session was distinct. The api CPU was above 80% of quota in 43 of 141 two-second windows (login only) and 54 of 110 (login+refresh).
6. **Not shown**: whether moving the compare outside the lock changes capacity (it should not, since CPU is the limit, only connection hold time); whether a cheaper refresh-token check would; and how a same-session concurrent refresh behaves. Those need the fix and a re-run, and the second is a security decision.

**Extrapolation (an assumption, not a measurement).** If students refresh once per 15-minute access-token lifetime (the maximum; `auth-token.config.ts`) and the frontend does so on expiry, 500 concurrently logged-in students generate about 33 refreshes per minute, which is about 55 to 75% of the measured 45 to 60 per minute ceiling before any other traffic, and a school-start login surge would stack on top. I have not verified the frontend's refresh cadence, and the ceiling is for this laptop's Docker CPU, not Fargate ARM, so the real number will differ; the shape of the collapse should not.

## PERF-03 remediation (branch `perf/batch-a`, commit 919810e): before and after

**Change.** `AuthService.rotateRefreshSession` now looks the session up by `refresh_token_id` without a lock, runs the bcrypt compare, hashes the replacement token, and only then opens the transaction, where it locks and re-reads the row and rejects if the row is gone or its stored hash is not the one that was verified. Single-use semantics, hash algorithm, cost factor and validation are unchanged. Unknown or already-rotated tokens are rejected before any bcrypt work (previously they paid for a full bcrypt hash first).

**Correction to the previous section.** A login is two bcrypt operations (compare the password, hash the new refresh token) and so is a refresh (compare the presented token, hash the replacement). So the throughput ceiling is "about 45 to 60 **logins or refreshes** per minute", which is roughly 90 to 120 bcrypt operations per minute, not 45 to 60 operations.

**Verification of correctness.** Unit tests: 4 of the 5 new tests fail against the old code and all pass with the change (order of compare, hash and transaction; unknown token costs no bcrypt and opens no transaction; hash changed between verify and lock; row gone at lock; bcrypt failure deletes the session). Whole auth unit suite 117/117; auth and CSRF e2e 19/19 on the disposable e2e database, including "two concurrent refreshes with the same cookie: exactly one 200". Lint, Prettier and `tsc` clean.

**Measurement.** Same scenario and parameters (`scenarios/auth-burst.js`, `MODE=refresh`), same host, old image kept as `learnix-api:loadtest-before`.

| Stage (iterations per minute) | victim p50 before (`auth-burst-3`) | victim p50 after (`auth-burst-5`) | refresh p50 before | refresh p50 after |
|---|---:|---:|---:|---:|
| 15 | 24 | 51 | 1087 | 1114 |
| 30 | 1316 | 1434 | 4792 | 6190 |
| 45 | 4502 | 4511 | 17473 | 20890 |
| 60 | 6548 | 5778 | 24320 | 28575 |
| quiet after | 17008 | 5713 | 14856 | 15321 |
| dropped iterations | 292 | 153 | | |

**Run-to-run noise is large.** A second "before" refresh-mode run (`auth-burst-4`, shorter stages) gave victim p50 1857 ms and refresh p50 6727 ms at 30 per minute, against 1316 and 4792 in `auth-burst-3`. The "after" values at 30 per minute (1434 and 6190) sit inside that spread. The only visible difference (recovery p50 17 s vs 5.7 s, dropped iterations 292 vs 153) is not larger than that noise from n = 1 per side, so I do not claim it.

**Result 1: capacity and the damage to unrelated requests are unchanged.** The collapse starts at the same load (between 15 and 30 iterations per minute) and the latency curve is the same. This is the expected outcome, because the limit is CPU on a 0.5 vCPU task and the change does not reduce the bcrypt work of a valid refresh.

**Result 2: the transaction hold time is shorter.** Same short run (`BURST_RATES=30,45`, `STAGE=60`, `QUIET=30`, sampled every 2 s, n = 99 samples each):

| | before (`auth-burst-4`) | after (`auth-burst-6`) |
|---|---:|---:|
| samples with any connection idle in transaction | 70 of 99 | 58 of 99 |
| mean connections idle in transaction | 2.08 | 1.10 |
| peak connections idle in transaction | 6 | 4 |
| peak total connections (api + worker) | 15 | 18 |
| lock waits | 0 | 0 |

It is lower but not zero, and it is one run on each side. Part of the remainder is expected: when the event loop is starved, even the short remaining transaction steps wait for the loop and so show as idle in transaction. Peak total connections did not drop. The pool of 10 per process was not exhausted in either run, so this change does not fix a failure that was occurring; it removes a way for one to start.

**Result 3: invalid-token path.** A refresh with a junk cookie now returns 401 in 6 to 8 ms (three requests, new build). The old path was not timed; from the code it paid for a bcrypt hash before the lookup, and the new unit test asserts that no bcrypt call or transaction happens.

**Trade-off to know about.** A refresh submitted twice with the same cookie at the same instant (two tabs, or a client retry) now spends bcrypt time on both requests before one is rejected at the lock; before, the loser waited at the lock and was rejected without bcrypt. Correctness is unchanged (the e2e concurrency test passes), but the duplicate costs CPU. I did not measure how often real clients do this.

**What this means for the plan.** The lock-scope fix is safe and worth keeping as hygiene, but it does not buy capacity. Raising the ceiling needs less bcrypt CPU per valid login or refresh, or more CPU, or keeping the work from starving other requests. Candidates, none implemented, ordered by how little they change security semantics:
1. **Measure bcrypt cost per operation in isolation** on this host (rounds 10 / 12) to separate raw hash cost from event-loop effects, before touching anything.
2. **Run bcrypt off the main thread** (native `bcrypt` on the libuv pool, or `worker_threads`). This would protect unrelated requests from starvation; it adds no CPU, and on a 0.5 vCPU quota the work still competes for the same budget. Needs a new dependency or a worker pool; to be measured with scenario K (watch the victim p50 at 15 to 45 per minute).
3. **Replace the bcrypt hash of the 512-bit random refresh token with a keyed fast hash** (HMAC-SHA-256). This removes two bcrypt operations from every refresh (the compare and the new hash) and one from every login. It is a security decision: the token is a high-entropy random value, so a slow hash adds little there, but it changes how credentials are stored and needs a migration path for existing sessions. Not done; needs your explicit approval.
4. More vCPU for the api task (cost decision), or autoscaling on CPU.

## Next measurements (in order)

1. Bcrypt cost per operation in isolation on this host (rounds 10 and 12), then the off-main-thread experiment from the PERF-03 section, re-measured with scenario K. The HMAC change for refresh tokens is a security decision and waits for your approval.
2. Spread the baseline's refreshes (random session age per VU) so the steady phase is representative, then repeat the teacher/admin reads at higher n with a whale-versus-small teacher split.
3. IDX-10 trial migration plus the teacher report queries (EXPLAIN, write cost, then re-run the baseline).
4. Remaining plan scenarios (load, stress, spike, soak), starting with a school-start login surge using `CLIENT_IPS=shared` to also exercise the per-IP throttle.

## Not done yet

- M / L seed runs (timing, disk, and whether the chunked inserts hold at 100k students).
- Exam content and attempt volume (created through the teacher API in k6 `setup()`, then cloned with SQL).
- Gamification data (the leaderboard is empty in the seed, so it would measure an empty table).
- Scenarios C to K (load, stress, spike, soak, endpoint, contention, isolation, pagination), exam journeys; the rest of the EXPLAIN campaign (two statements covered; L dataset not seeded); all remediation batches.
- EasyKash stub (needed for commerce write and contention scenarios).
