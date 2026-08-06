# Staging Redis Setup

Phase 2 deliverable. Companion to [`STAGING_DATABASE_SETUP.md`](STAGING_DATABASE_SETUP.md) and
[`PHASE_2_RAILWAY_CHECKLIST.md`](PHASE_2_RAILWAY_CHECKLIST.md). No secret values appear in this
document.

## 1. What already existed before Phase 2

- Every Redis consumer already fails fast rather than hanging: `maxRetriesPerRequest: 1` and
  `retryStrategy: () => null` on every non-production connection, so an unreachable `REDIS_URL`
  produces one clear error instead of an infinite reconnect loop.
- Production keeps each library's own default retry behaviour (retry-forever) — a deliberate,
  already-reviewed choice: a real production Redis outage should trigger reconnection attempts,
  not a fast-fail.
- Redis is mandatory in production (`app.module.ts`, `queues.module.ts` both throw at boot if
  unconfigured); optional in development (falls back to in-memory cache / `NoopQueue`).
- `REDIS_URL`/`REDIS_HOST` host-isolation checks already existed from Phase 0
  (`STAGING_PRODUCTION_REDIS_HOST`), and `REDIS_NAMESPACE`'s *shape* was already validated
  (`STAGING_REDIS_NAMESPACE_NOT_MARKED`) even though nothing used the value yet.
- Sessions and token revocation live in Postgres (`user_sessions` table), not Redis — there is no
  "session prefix" to add; that subsystem was never in Redis to begin with.

## 2. What Phase 2 added: real key namespacing

Before this phase, `REDIS_NAMESPACE` was validated but never applied — isolation between
environments depended entirely on each having a *different Redis host*. Real, but not defence in
depth: a misconfigured staging instance sharing a host with production would have collided on
every cache, queue, rate-limit, and idempotency key.

`src/common/utils/redis-namespace.util.ts` is the single source of truth now. Three functions:

| Function | Returns | Used for |
|---|---|---|
| `resolveRedisNamespace(get)` | `''` (production default) / `'learnix:staging'` / `'learnix:test'` / an explicit `REDIS_NAMESPACE` override | The raw namespace |
| `namespacedPrefix(get)` | The namespace + `:`, or `''` | String-concatenation prefixes (cache, idempotency, lock, health-collector keys) |
| `bullMqPrefix(get)` | The bare namespace, or `undefined` | BullMQ's own `prefix` queue option, which adds its own separators |

**Why production's default is empty, not `learnix:prod`:** production never sets `REDIS_NAMESPACE`
today. If the default for a resolved-production environment were non-empty, every cache, queue,
rate-limit and idempotency key would change shape the moment this code deploys — a live behaviour
change to the currently-deployed service. Empty-by-default means production's key shapes are
byte-identical to before this phase. Staging and test get useful non-empty defaults even without
configuration, since neither has a legacy key to stay compatible with. An explicit
`REDIS_NAMESPACE` always wins, in any environment.

### Wired into every Redis consumer

| Consumer | Before | After (staging example) |
|---|---|---|
| Cache (`RedisKeyvStore`) | `learnix:cache:<key>` (fixed literal) | `learnix:staging:learnix:cache:<key>` |
| BullMQ (12 queues) | `bull:<queue>:<key>` (library default) | `learnix:staging:<queue>:<key>` |
| Rate limiting (`ThrottlerStorageRedisService`) | no prefix | `learnix:staging:` + the library's own key shape |
| Idempotency (`IdempotencyService`) | `idempotency:webhook:...` / `idempotency:payment:...` | `learnix:staging:idempotency:webhook:...` |
| Distributed lock (`DistributedSingleFlightService`) | `cache-lock:<key>` | `learnix:staging:cache-lock:<key>` |
| Health-collector coordination | `learnix:health:collector:state:v2` etc. | `learnix:staging:learnix:health:collector:state:v2` |

(The cache and health-collector keys keep their own pre-existing `learnix:` literal nested inside
the environment prefix — a minor cosmetic redundancy on staging, not a correctness issue, and
deliberately not "fixed" by changing what production's key looks like.)

**Why one variable instead of `QUEUE_PREFIX` / `CACHE_PREFIX` / `RATE_LIMIT_PREFIX`:** letting an
operator set these independently would let one subsystem drift out of sync with another,
undermining the entire point — an environment's keys are either fully separated or they are not.
`REDIS_NAMESPACE` covers all of them by construction.

**Verified:** 15 unit tests for the resolver itself, plus targeted tests for each wired consumer
(cache prefix behaviour, BullMQ `prefix` option presence/absence, idempotency key shape on both
production and staging, health-collector key namespacing) — 26 tests total across
`redis-namespace.util.spec.ts`, `redis-keyv.store.spec.ts`, `idempotency.service.spec.ts`, and the
existing `health-collector-coordinator.service.spec.ts` (which already asserted literal key names
and continues to pass unchanged, because its fake `ConfigService` sets `NODE_ENV: 'production'`
explicitly). A full E2E spec (`auth.e2e-spec.ts`) was also re-run against the fully-namespaced app
under `NODE_ENV=test` and passed 11/11, proving the wiring doesn't break request handling.

## 3. Reliability — what this codebase already gets right, unchanged by this phase

| Concern | Behaviour |
|---|---|
| Connection timeout | 2–5s across every Redis client, consistently |
| Retry strategy | Fail-fast (`retryStrategy: () => null`) outside production; library default (retry-forever) in production |
| Reconnect strategy | Same split as retry strategy |
| Offline queue | Not explicitly configured; BullMQ/ioredis defaults apply |
| TLS | Handled by the connection string scheme (`rediss://`) — no separate `REDIS_TLS` variable was added, matching the same reasoning as `DATABASE_SSL` (see `STAGING_DATABASE_SETUP.md` §1) |
| Graceful shutdown | **New this phase**: `app.enableShutdownHooks()` in `main.ts` — every Redis-backed service here (`IdempotencyService`, `DistributedSingleFlightService`, `HealthCollectorCoordinatorService`, the throttler storage adapter) already implements `OnModuleDestroy`; this is what makes Nest actually call it on `SIGTERM` |

## 4. Liveness, readiness, and degraded mode — the distinction this codebase implements

| Tier | Endpoint | Checks | Used for |
|---|---|---|---|
| **Liveness** | `GET /health` (via `HealthService.getPublicLiveness`) | Nothing — always `healthy` if this code is running | "is the process up at all" |
| **Readiness** | `GET /health/readiness` | Postgres (`SELECT 1`) **and, new this phase, Redis (`PING`) when configured** | "should traffic be routed here" — a routing decision |
| **Degraded** | `GET /health/all` (admin-only) | Every indicator (database, redis, queue, storage, scheduler, document, backend-api, external-providers), each reporting `healthy`/`warning`/`degraded`/`down` | Diagnosis, not routing — a component can be `degraded` without the service being `not_ready` |

**Is Redis mandatory for all modules, or only some?** Mandatory at boot in production (the app
refuses to start without it); optional in development. Once running, everything that touches
cache, rate limiting, queues, idempotency, or cross-replica health coordination depends on it —
which is effectively the whole request path, since the global rate limiter alone sits in front of
every route.

**What changed:** before this phase, `getReadiness()` checked only Postgres. A Redis outage that
happened *after* boot (network blip, Redis restart) was invisible to the readiness probe — Redis
is required at boot, but nothing re-verified it afterwards. Railway could keep routing traffic to
an instance whose cache/queues/rate-limiting were silently non-functional. `HealthService` now
pings Redis too (a lightweight, short-lived connection, not the full `RedisHealthIndicator`'s
INFO-based diagnostics — this probe needs to be cheap, since it can fire every few seconds).

## 5. Queue and worker isolation

12 BullMQ queues, one shared connection (`queues.module.ts`). Isolation is now two layers:

1. **Different Redis host** (Phase 4 — a separate Railway Redis service for staging).
2. **`BullModule`'s `prefix` option**, set from `bullMqPrefix()` (this phase) — even a
   misconfigured shared host can no longer let a staging worker consume a production job, because
   BullMQ identifies a queue by `prefix:name`, and the prefixes differ.

`ENABLE_BACKGROUND_JOBS` (Phase 0) still gates whether queues connect to Redis at all versus
resolving to `NoopQueue` — unaffected by, and compatible with, the namespace change. The five
Phase 0 feature flags (`ENABLE_PAYMENT_RECONCILIATION`, `ENABLE_WEBHOOK_REPLAY`,
`ENABLE_FILE_CLEANUP`, `ENABLE_NOTIFICATIONS`, `ENABLE_BACKGROUND_JOBS`) all continue to work
identically under the namespaced queues — the flags gate whether a job runs at all, independent of
which Redis keys it would use.

## 6. What this phase does NOT do

- Does not create the `learnix-staging` Railway Redis service — see
  [`PHASE_2_RAILWAY_CHECKLIST.md`](PHASE_2_RAILWAY_CHECKLIST.md).
- Does not change the readiness-criticality semantics further (e.g. a "degraded but serving"
  carve-out for a Redis-down state) — flagged as a Phase 8 (Monitoring) consideration, not
  attempted here since it would change production's own health-reporting semantics beyond this
  phase's Database-and-Redis scope.
