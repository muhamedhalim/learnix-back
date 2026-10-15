# Known E2E Failures

**Status as of 2026-08-26: none. The suite passes.**

`npm run test:e2e -- --ci --runInBand --forceExit`, exit code **0**,
`Test Suites: 35 passed, 35 total` / `Tests: 299 passed, 299 total`, 505s.
Postgres 16 and Redis 7 (`test-postgres-1`, `test-redis-1`) were created fresh
via `npm run test:e2e:infra:up` immediately before the run.

Everything previously listed here has been resolved. Nothing on the old list
turned out to be a defect in application behaviour — the two entries filed as
"pre-existing application bug" were both mis-diagnosed, and are explained below
so the same conclusions are not drawn again.

---

## How to run

```bash
npm run test:e2e:infra:up      # fresh Postgres + Redis (tmpfs, disposable)
npm run test:e2e -- --ci --runInBand --forceExit
npm run test:e2e:infra:down
```

The suite requires `.env.test` (untracked). Beyond the database/Redis URLs and
JWT/cookie secrets it needs **`MEETING_TOKEN_ENCRYPTION_KEY`** — a local
base64-encoded 32-byte AES key used to encrypt the meeting-account token column
in fixtures. It is not a credential for any external service; generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

---

## What was actually wrong

### The blocker: `synchronize` ran once per suite

E2E builds its schema with TypeORM `synchronize` (it cannot use migrations —
see below). Every suite calls `createE2EApp()`, which re-ran it, and the second
run failed hard:

```
QueryFailedError: operator does not exist:
  scheduled_lesson_sessions_meeting_status_enum =
  scheduled_lesson_sessions_meeting_status_enum_old
```

`scheduled_lesson_sessions.meeting_status` is an enum column carrying a
**partial** index whose predicate casts to that enum type. TypeORM cannot
round-trip that predicate, concludes the column changed, and takes its
enum-alteration path — rename the type to `…_old`, create the new type,
`ALTER COLUMN … TYPE`. The last step re-evaluates the index predicate, which
still references `…_old`, so it fails. TypeORM then retried the connection
forever and the run **hung with no output**, which is why earlier sessions saw
mass failures or an apparently stuck suite.

Fixed by `test/global-setup-e2e.ts`: the schema is built exactly once, before
any suite, and `.env.test` now sets `TYPEORM_SYNCHRONIZE=false` so suites only
connect. The setup probes for an existing schema first, so repeated local runs
work without tearing down Docker. Production is unaffected — it has always run
migrations with `synchronize` hard-disabled (`app.module` refuses to boot
otherwise).

> **Why not migrations?** They cannot replay from an empty database. `migration:run`
> against a fresh one fails immediately on `InitialSchema1734986400000` with
> `column "status" does not exist` — the chain was baselined against an existing
> database. Switching E2E to migrations would be the more faithful option and is
> worth doing, but it requires repairing the chain first.

### #1 `subjects-ownership` — **was NOT an application bug**

Previously filed as "pre-existing application bug — expected 200, got 400 …
reproduces on the clean baseline". It was two test defects:

- `createTeacherSubject` sent `multipart/form-data` (`.field('name', …)`) to
  `POST /teacher/subjects`, which takes `CreateSubjectDto` through `@Body()` and
  has no file interceptor. Subjects lost their thumbnail in migration 2074, which
  is when that endpoint stopped accepting a form upload; the rest of the spec had
  already been migrated to `.send()`, these two call sites were missed. `name`
  arrived unparsed, so ValidationPipe answered 400.
- The suspension test read the new lesson's id from `body.id`, but
  `POST /teacher/lessons` answers `{ message, lesson }`. `body.id` was
  `undefined`, the next call became `GET /teacher/lessons/undefined`, and
  `ParseUUIDPipe` answered 400 — _that_ was the "expected 200, got 400".

The behaviour the suite guards (editing content whose subject was suspended) was
never broken: `LessonsService.validateSubjectChange` only re-validates when
`subject_id` actually changes. 18/18 now pass.

### #2 `payment-financial-state-machine` — **was NOT a race condition**

Filed as "a genuine race condition in the settlement worker". It passes
consistently now; the failure was the `synchronize` blocker above, which
prevented the app from booting cleanly for later suites.

### #3 `call-center-phase6` — missing fixture, not an RBAC bug

Filed as "RBAC route mismatch, expected 200 got 403". The E2E helper
`setUserRole` flipped `users.role` only, leaving `finance_permissions` at its
`'[]'` default, so the test's "admin" genuinely lacked `reports.view` and
`FinancePermissionsGuard` correctly refused. Real administrators are created by
`AdminInitializationService` with the full `FINANCE_PERMISSIONS` set. The helper
now provisions the role the same way (and explicitly clears permissions for
non-admins, preserving migration 2058's invariant).

### #4 `call-center-phase5` — the authorization gap is closed

Filed as "support-role student-edit route, expected 403, got 200". The route
(`PUT /callcenter/students/:studentId`) is now `@Roles('admin')` and the test
passes. The suite's own name for it — "protects the legacy Admin surface" — is
now accurate.

### #5 `certificates` / `certificate-refund-lifecycle` — deadlock in `resetDatabase()`

Correctly diagnosed as a harness flake. `resetDatabase()` issues one
`TRUNCATE … RESTART IDENTITY CASCADE` across every table, taking ACCESS
EXCLUSIVE locks on all of them, while the live app's post-commit listeners (a
certificate auto-issue, a notification insert) are still writing. Postgres kills
one side. The fix proposed in this document has been implemented: a bounded
retry on SQLSTATE `40P01`, since the loser of a deadlock is expected to retry
and the listener's transaction has resolved by the next attempt. The retry is
capped so a genuine permanent lock problem still fails rather than hangs.

### #6 `auth` — default test timeout too low

Filed as resource contention. Correct in substance. Registration tests do
several bcrypt hashes against a real database and legitimately exceed Jest's
**5 s** default late in a sequential run — `call-center-phase1` measured 3.8 s
per test in isolation, i.e. within a whisker of the limit. `test/jest-e2e.json`
now sets `testTimeout: 30000`. No assertion was relaxed; the harness simply
stops killing correct work.

### #7 `teacher-follow-up-ownership` golden — test bug (timezone) plus an unordered timeline

**Environment/test bug, plus a real ordering gap.** The suite failed on UTC runners (and once on a clean local
run) with normalised timestamps that differed by rank (`t10` vs `t08`, `lastMarkedAt` `t04` vs `t03`). Two causes,
both reproduced against a fresh `postgres:16`:

- **The golden encoded the capturing machine's timezone.** Most timestamp columns are `timestamp without time
zone`; node-postgres reads them as _local_ time. On a developer machine in `Africa/Cairo` an attendance
  `marked_at` of `2026-01-05T10:00Z` came back as `08:00Z`, the golden ranked those shifted instants, and the same
  data on a UTC runner produced different ranks (`TZ=UTC npx jest ... teacher-follow-up-ownership` failed
  deterministically, the Cairo default passed). `test/global-setup-e2e.ts` now pins `TZ=UTC`, the zone of CI and of
  the deployed containers.
- **The timeline had no total order.** `/teacher/students/:id/timeline` merges exam, attendance, homework and
  notification events and sorted them with `a.at < b.at ? 1 : -1`, a comparator that never returns 0. Events that
  share an instant (the fixture marks attendance at the instant an exam is graded; a message is queued, sent,
  delivered and read by one callback) came out in whatever order the sources were read. It is now
  `compareTimelineEntries`: newest first, ties broken by lifecycle stage then label (unit-tested). The roster
  (`name`, `id`), guardian list (`..., sg.id`), scoped message fetch and the admin parent-message list
  (`created_at DESC, id DESC`) got the same unique tie-breaker: they paginate or return rows whose sort key can
  repeat.
- The normaliser also ranked instants generated by the run itself (`now()` defaults, `new Date()`), so two rows
  created in the same millisecond collapsed into one rank and shifted every later rank by machine speed. Those
  instants are now rendered `now`; only the fixture's own January 2026 instants are ranked.

The golden was regenerated once, deliberately: apart from timestamp tokens the only content change is the order of
two adjacent timeline entries for student `s1` (attendance marked `2026-01-05T10:00Z` now precedes the exam start at
`09:40Z`, which is newest-first and is what the old, timezone-skewed capture got wrong). Authorization checks and
every other response are unchanged.

### #8 Postgres `ERROR` lines in a green run — expected noise, and what to read

- `constraint "..." for relation "..." already exists` (`CHK_teacher_settlement_entries_amount_positive`,
  `chk_teacher_settlements_fiscal_period`): `payment-recovery.postgres.e2e-spec.ts` replays migrations
  `2054000000000` / `2056000000000` over the entity-built schema, which already has those constraints. The
  migrations catch exactly the `already exists` error (PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`) and
  rethrow anything else; the server logs the failed statement regardless. Not a failure, and not a duplicate
  migration run: the migration chain test (`npm run test:migrations`) applies all 151 migrations to an empty
  database with none pending and no such error. Caveat: those catch blocks accept _any_ existing constraint of that
  name, not only one with the intended definition; a drifted production constraint would not be reported.
- `duplicate key value violates unique constraint "UQ_..."`: the tests that assert uniqueness (reviews, open
  applications, ...) provoke it on purpose.
- `relation "complaint_ticket_number_seq" does not exist`: the sequence belongs to migration
  `2059000000000`, and the entity-built E2E schema had none, so every ticket logged this error and took the
  `42P01` fallback in `ComplaintsService.nextTicketNumber()`. `test/global-setup-e2e.ts` now creates it (same DDL,
  `IF NOT EXISTS`), so the production numbering path is what E2E exercises. In production the migration creates it;
  `npm run test:migrations` proves that on an empty database.
- `deadlock detected`: a post-commit listener (`EarningsPayoutNotificationListener`,
  `FreeEnrollmentNotificationListener`, certificate auto-issue) still inserting when the next test's
  `resetDatabase()` takes `ACCESS EXCLUSIVE` on every table (inverted lock order between the test harness and the
  listener; nothing in the application takes locks in an inverted order). `resetDatabase()` now waits (bounded, 2 s)
  until no other session on the database is active or idle-in-transaction before truncating, and still retries a
  deadlocked truncate. A listener that loses a deadlock logs and drops its notification.

### #9 `could not determine data type of parameter $1` / `bind message supplies N parameters` — application bug (fixed)

Not noise: `GET /admin/finance/reports` builds each widget with `Promise.allSettled`, so a widget whose SQL throws
is reported in `widget_errors` and rendered **empty**, and the suites stayed green. Two defects:

- `revenue_trends`, `product_breakdown` and `top_products` use only the `current_orders` CTE but ran through
  `runFinancialReportQuery`, which also binds the previous-period CTE's parameters (always 2 more, plus the
  filters): "bind message supplies 8 parameters, but prepared statement requires 4". They now use
  `runCurrentFinancialReportQuery`. This hit every request, filtered or not.
- `settlement_analytics`, `ledger_movements` and `settlement_history` appended their filter placeholders to the
  parameter list the CTEs had already filled, giving `$9`/`$10` with `$1`..`$8` unreferenced when `currency` /
  `teacher_id` were set. They now start from an empty list.

`academic-reporting-invariance` T054 asserts `widget_errors` is empty for the full report (it failed with six
widgets before the fix). Its old comment, "some of them fail in the full report on this database for reasons
unrelated to selection", was this bug.

### #10 "A worker process has failed to exit gracefully"

Not a leak of application resources: after `app.close()` no pg/Redis socket remains (`process._getActiveHandles()`
holds only stdout/stderr) and `--detectOpenHandles` reports nothing. The one thing alive is a 2 s timer created by
ioredis' `disconnect()`, called from `ThrottlerStorageRedisService.onModuleDestroy` (third-party). It expires by
itself; jest prints the warning because it checks one second after the run. It does not change the exit code and
the run is not hung.

---

## Adding to this file

Record a failure only after running the suite against **freshly created**
infrastructure and reproducing it in isolation (`-t "<name>"`). State which of
these it is — application bug, test bug, stale expectation, missing fixture, or
environment/setup — and give the evidence. Two entries here were called
application bugs for weeks on the strength of "it reproduces on the baseline",
which only ever proved the _test_ was equally wrong on the baseline.
