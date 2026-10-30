# Learnix load-test stack (local)

Disposable local stack for performance measurement. Plan and findings: `docs/performance/load-test-results.md`.
Nothing here talks to a deployed environment. **Never point any of this at production.**

## What is here

| Path                                 | Purpose                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.loadtest.yml`        | Postgres 16 (TLS on, `pg_stat_statements`, capped near `db.t4g.small`), Redis 7 (`noeviction`), and with `--profile app` the production image as `api` + `worker` (0.5 vCPU / 1 GiB each)           |
| `loadtest.env`                       | Throwaway config for the api/worker containers. The only env source for them: nothing is interpolated from your shell, so a real provider key exported in your terminal cannot reach the containers |
| `../../scripts/loadtest-db-build.ts` | Builds the schema from the **migration chain** (not `synchronize`). Refuses unless the DB name contains `load` and the host is local                                                                |
| `../../scripts/seed-lms-load.ts`     | Bulk-seeds the LMS core (profiles S / M / L). Same guards. Writes `.data/seed-manifest.json` (gitignored)                                                                                           |
| `catalog.k6.js`                      | Existing marketplace scenario (FR-331). Marketplace is off in production; keep it as an opt-in scenario                                                                                             |

## Run it

```bash
# from learnix-back
docker compose -f learnix-infra/loadtest/docker-compose.loadtest.yml up -d --wait postgres redis
export DATABASE_URL=postgres://postgres:lms_load_password@localhost:55433/lms_load
npm run loadtest:db:build -- --recreate        # 156 migrations, ~5 s
npm run seed:lms-load -- --profile=S           # S ~2 s; M / L take minutes (see results doc)
docker compose -f learnix-infra/loadtest/docker-compose.loadtest.yml --profile app up -d --wait
curl -s http://localhost:3001/api/v1/health    # api on :3001, worker on :3002
```

Metrics (bearer token from `loadtest.env`): `curl -H "Authorization: Bearer loadtest-metrics-token" localhost:3001/metrics`.

Reseeding always starts from `loadtest:db:build -- --recreate`; stop `api` and `worker` first (they hold connections) and
`redis-cli flushall` on the load Redis afterwards, since cached entries reference the old row ids.

## Run a scenario

```bash
cd learnix-infra/loadtest
node collect/run.mjs scenarios/smoke.js --run-id=smoke-1      # k6 + server-side evidence -> results/smoke-1/
k6 run -e RUN_ID=adhoc scenarios/smoke.js                     # k6 alone (create results/adhoc first: k6 cannot mkdir)
```

`collect/run.mjs` drives the local stack only. It resets `pg_stat_statements`, samples containers / Postgres / Redis /
`/metrics` every 5 s, and writes `routes.json` (server-side avg ms and SQL queries per request per route),
`statements.json`, `samples.jsonl`, `summary.json`, `run.json`.

Targets are guarded in `lib/config.js`: local hosts run freely, the staging API needs `-e CONFIRM_TARGET=<host>`, every
`*.learnix.school` host and anything unknown is refused. Each VU presents its own client IP via `X-Forwarded-For`
(local only) because the api throttles per IP; `-e CLIENT_IPS=shared` puts all VUs behind one address to reproduce a
school NAT. Background and the production limits are in `docs/performance/load-test-results.md`.

## Test accounts

Every account is `<role><n>@load.learnix.invalid` (`.invalid` is reserved by RFC 2606, so mail can never be
delivered) with one shared synthetic password, recorded in `.data/seed-manifest.json`. Examples: `admin1@…`,
`teacher1@…` (the "whale", about 30 % of enrollments), `student1@…`.

Authenticating needs the CSRF flow: `GET /api/v1/auth/csrf-token` (sets the cookie, returns `token`), then send
`X-CSRF-Token: <token>` with `POST /api/v1/auth/login`. Cookies set: `access_token`, `refresh_token`, `XSRF-TOKEN`.

## Stall attribution and the auth burst

- `collect/run.mjs` also starts `collect/probe.mjs` (own process: 5 Hz `/health` round-trips plus api CPU seconds) and has k6 write `results/<run>/k6-points.json`. `PROBE=0` turns both off.
- `node collect/analyze-stalls.mjs <run-id>` lists stall episodes and what was in flight; `node collect/clean-window.mjs <run-id>` gives per-endpoint latency for the part of a run with no auth request active.
- `scenarios/auth-burst.js` (local only) steps up login arrivals against a steady stream of cheap public GETs. `node collect/run.mjs scenarios/auth-burst.js --run-id=x [-- -e MODE=refresh -e BURST_RATES=15,30,45,60 -e STAGE=60 -e QUIET=45]`. Rates are per minute. It deliberately saturates the api CPU.
- The `backend_nodejs_eventloop_lag_*` gauges are process-lifetime values; do not read them as per-run figures.
