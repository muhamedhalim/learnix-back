# Phase 2 Railway Checklist — Database and Redis

Everything in this document requires Railway dashboard access this session does not have. Nothing
here has been created. Perform these steps in order; each step lists what to verify before moving
to the next. No secret values are written down anywhere in this document — only variable **names**
and where to find the **values** Railway generates for you.

## Before you start

Confirm you have answers to Q1/Q6 from the original plan (§22): the current production Railway
topology (replica count, region, Postgres major version, resource limits) and a staging budget
ceiling. Staging should mirror production's Postgres major version specifically — a version
mismatch is exactly the kind of thing that makes "it worked in staging" not mean "it will work in
production."

## Step 1 — Create the Railway project

1. Railway dashboard → New Project → empty project.
2. Name it `learnix-staging` (a **separate project**, not an environment inside the existing
   production project — see §4 of the original plan for why: shared variables inside one project
   are exactly the mechanism that already leaked production Redis/R2 credentials into a local
   `.env` once, per finding R2).
3. **Verify:** the project exists, is empty, and is visibly distinct from the production project in
   the project switcher.

## Step 2 — Provision Postgres

1. Inside `learnix-staging` → New → Database → Add PostgreSQL.
2. Match production's major version if at all possible (check with `SELECT version();` against
   production, or from the inventory recorded in `docs/ENVIRONMENT_INVENTORY.md` if already
   captured there).
3. **Verify:** `SELECT version();` against the new instance returns the expected major version.
4. Compare installed extensions against production:
   ```bash
   psql "$STAGING_DATABASE_URL" -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
   ```
   Only `uuid-ossp` is required by the migration chain (created by the first migration itself) — if
   production has additional extensions installed out-of-band, reconcile before proceeding.
5. Copy the Postgres service's **private network URL** (`*.railway.internal`) — this is what
   `DATABASE_URL` will be set to on the API service (Step 5), not the public proxy URL. Private
   networking keeps the database off the public internet entirely.
6. **Verify naming:** the database name must contain "staging" or "stg" (e.g. `railway`'s default
   database name does NOT qualify — rename it, or note the actual database name Railway assigned
   and confirm it satisfies this). The environment-isolation guard (`STAGING_DATABASE_NAME_NOT_MARKED`)
   refuses to boot otherwise, by design.
7. Enable Railway's own backup feature for this service if available on the plan, **in addition
   to**, not instead of, `scripts/db-backup.sh`.

## Step 3 — Provision Redis

1. Inside `learnix-staging` → New → Database → Add Redis.
2. Copy the Redis service's **private network URL** (`*.railway.internal`), same reasoning as
   Step 2.5.
3. **Verify:** `redis-cli -u "$STAGING_REDIS_URL" PING` returns `PONG` (run this from a context that
   can reach the private network — e.g. a Railway shell against the API service, once it exists).

## Step 4 — Run the migration chain against the new, empty database

This is the single biggest open question this plan ever flagged (finding R1) — it has already been
proven safe against local Postgres and a temporary database (Phase 0/2), but never against the
actual staging instance until this step.

1. From a machine or Railway shell that can reach the new Postgres over its private (or, for this
   one-time step, temporarily public) URL:
   ```bash
   DATABASE_URL="$STAGING_DATABASE_URL" APP_ENV=staging npm run migration:run:prod
   ```
   (This now runs through the advisory-locked CLI — see `STAGING_DATABASE_SETUP.md` §3 — so it is
   safe even if run twice by accident.)
2. **Verify:** `DATABASE_URL="$STAGING_DATABASE_URL" npm run migrate:status` reports "No pending
   migrations" and lists all 104.
3. Drift check — the generated migration's `up()` must be empty:
   ```bash
   DATABASE_URL="$STAGING_DATABASE_URL" npx typeorm -d dist/src/data-source.js migration:generate src/migrations/TEMP-DriftCheck
   ```
   Delete the generated file either way; it is diagnostic only, never committed.

## Step 5 — Create the Railway API service (Phase 4 territory, listed here for the DB/Redis variables specifically)

Only the Database-and-Redis-relevant variables are listed here — the full variable set is Phase 4's
job. Set on the `learnix-staging` API service once it exists:

| Variable | Value |
|---|---|
| `APP_ENV` | `staging` |
| `DATABASE_URL` | The Step 2 private network URL |
| `REDIS_URL` | The Step 3 private network URL |
| `REDIS_NAMESPACE` | Leave unset (defaults to `learnix:staging` automatically) unless you have a specific reason to override it |
| `DB_POOL_MAX` / `DB_POOL_MIN` / `DB_POOL_IDLE_TIMEOUT_MS` / `DB_POOL_CONNECTION_TIMEOUT_MS` | Only if staging's Postgres plan has a materially different connection limit than production's defaults (10/2/30000/10000) already assume |
| `RUN_MIGRATIONS` | Leave unset (migrations run automatically on boot, advisory-locked) |
| `ALLOW_STAGING_SEED` | Leave unset until Phase 7, when the seed is actually meant to be run |

**Two-person review before the first deploy:** have a second person independently confirm
`DATABASE_URL` and `REDIS_URL` both resolve to the `learnix-staging` project's own services, not
production's — this is exactly the class of mistake the environment-isolation guard exists to
catch at boot, but a human check before the first deploy costs nothing and catches it sooner.

## Step 6 — First boot verification

1. Deploy the API service.
2. **Verify the isolation guard is satisfied, not bypassed:** the deploy should succeed. If it
   fails with an `EnvironmentIsolationError`, read the listed violation codes — they name exactly
   which variable is wrong (e.g. `STAGING_PRODUCTION_DATABASE_HOST` means `DATABASE_URL` is
   pointed at production).
3. `GET /api/v1/health` → `200`, `status: healthy`.
4. `GET /api/v1/health/readiness` → `200`, `status: ready` (this now checks Redis too, per
   `STAGING_REDIS_SETUP.md` §4 — a `not_ready` here that wasn't present before this phase's change
   means Redis specifically is unreachable, not Postgres).

## Step 7 — Deliberate drills (do these once, on purpose, then revert)

These prove the guards actually fire in the real deployed environment, not just in unit tests —
matching the plan's own standard ("a guard that has never been seen to fire is not a guard").

1. Temporarily set `DATABASE_URL` to a value with `learnix` (no staging marker) as the database
   name. Redeploy. **Expect:** the deploy fails at boot with `STAGING_DATABASE_NAME_NOT_MARKED` or
   `STAGING_PRODUCTION_DATABASE_NAME`. Revert.
2. Temporarily set `TYPEORM_SYNCHRONIZE=true`. Redeploy. **Expect:** fails at boot with
   `STAGING_SYNCHRONIZE_ENABLED`. Revert.
3. Temporarily set `REDIS_NAMESPACE=production` (no staging marker). Redeploy. **Expect:** fails at
   boot with `STAGING_REDIS_NAMESPACE_NOT_MARKED`. Revert.

## Step 8 — Backup and restore drill

1. `DATABASE_URL="$STAGING_DATABASE_URL" ./scripts/db-backup.sh` — confirm a `.dump` file is
   produced and passes its own integrity check.
2. Provision a **second, scratch** Postgres database (never the staging instance itself) and
   restore into it:
   ```bash
   DATABASE_URL="$SCRATCH_DATABASE_URL" ./scripts/db-restore.sh path/to/backup.dump
   ```
3. **Verify:** row counts in the scratch database match the source, and `npm run migrate:status`
   against the scratch database reports the same migration count as staging.

## What is explicitly NOT part of this checklist

- DNS records for `api-staging.learnix.school` (Phase 4).
- Vercel / frontend setup (Phase 4).
- R2, Bunny, Paymob, MailerSend, Twilio, Meta, Firebase, Sentry provisioning (Phase 3).
- CI/CD deploy workflows and branch protection (Phase 5).
- The remaining `staging-isolation.guard.ts` checks beyond what Phase 0/2 already cover (Phase 6).
- Running the synthetic seed (Phase 7 — `ALLOW_STAGING_SEED` and the seed script both exist and are
  proven, but are deliberately not run against any real environment yet).

## Rollback

Nothing in this checklist is destructive to Production. If any step goes wrong: delete the
`learnix-staging` project and start over — it holds nothing Production depends on. This is also why
Phase 2 was executed as a separate Railway project rather than an environment inside the production
project (§4 of the original plan).
