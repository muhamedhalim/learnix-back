# Phase 5: performance, DR and cost validation

Runs against the staging environment after Phase 4 passes, with staging **sized like production's Low
configuration** for the load test. Nothing here has been executed; the tooling below was only checked for syntax
and, for the load script, loaded by k6 (`k6 inspect`).

## 1. Load test (FR-331, SC-013)

Target: p95 <= 500 ms for catalogue list and search, <= 400 ms for course detail and curriculum, at **500
concurrent learners and 50 concurrent instructors**, with 50,000 published courses and 500,000 enrollments.

1. **Size staging like production Low** for the duration: `db_instance_class = "db.t4g.small"` with
   `multi_az = true`, `valkey_node_type = "cache.t4g.micro"`, two `api` tasks (0.5 vCPU / 1 GB) and two `web`
   tasks. Revert afterwards.
2. **Seed** the catalogue at scale: `npm run seed:marketplace-load` (learnix-back; it refuses unless the database name
   carries a staging/load marker). The runtime image contains only the compiled `src` (no `scripts/`), so run it from
   a checkout on the SSM-managed `db-access` host in the VPC (or add a compiled seed entry point to the image). Check
   `EXPLAIN` plans for the three list queries use their indexes.
3. **Open the gate for the generator**: add its address to `allowed_ipv4_cidrs`; keep the WAF managed rules in
   COUNT mode so the per-IP rate rules do not throttle one load source.
4. **Run** (from a host in or near Europe/Middle East, not a laptop on Wi-Fi):

   ```bash
   k6 run -e BASE_URL=https://<site> loadtest/catalog.k6.js
   # with instructor traffic: -e INSTRUCTOR_TOKEN=<access_token cookie of an instructor>
   ```

   For server-side numbers without the edge, the existing `learnix-back/scripts/load-marketplace-catalog.cjs`
   (autocannon) can be pointed at the ALB from inside the VPC with `LOAD_TEST_BASE_URL`.
5. **Watch** during the run: ECS CPU and memory, RDS CPU / connections / `DatabaseConnections` against the alarm
   threshold, Valkey memory, ALB 5xx, the application error metric.
6. **Decide**: all k6 thresholds green -> Low is the launch configuration. A miss -> change one thing (task size,
   DB class, an index, a missing cache) and re-run; moving to the Expected configuration is the fallback
   (plan section 6.5). Record the final numbers in `docs/cost/load-test-results.md`.

The k6 script is the *client-side* number, which includes CloudFront and the WAF. If it fails but the autocannon
run inside the VPC passes, the problem is at the edge (TLS, region distance from the generator, WAF).

## 2. Read-only root filesystem trial

Staging runs `read_only_root_filesystem = true` for `api` (and `worker`); production turns it on after staging
proves it. In staging deploy, then check the task starts and serves (`/api/v1/health/readiness`, an upload, a code
export, a PDF/certificate). If the non-root `node` user cannot write to `/tmp`, fix it in the Dockerfile (create and
`chown` the directory, declare it as `VOLUME`) rather than weakening the setting. There is no `web` task: the
frontend runs on Vercel.

## 3. PITR restore drill

```bash
scripts/pitr-restore-drill.sh learnix-staging-pg --minutes-ago 15
```

Restores to a scratch instance named `...-drill-<timestamp>`, waits for it to become available, prints the
**measured restore time (RTO)**, then deletes only that scratch instance (`--keep` to inspect it first). The source
instance is never modified. Run `scripts/restore-verification.sql` against both and compare row counts. Record in
`docs/cost/dr-drill-log.md`: date, restore point, restore seconds, row-count comparison, who ran it. Target from the
plan: RPO <= 5 minutes, RTO <= 1 hour. Repeat monthly in production once it exists.

Also exercise the other recoveries once: kill a task (replacement < 2 min), force an RDS failover with
`multi_az = true` (2-5 min), roll back a bad deploy via the circuit breaker, restore one S3 object from a previous
version.

## 4. Region-loss tabletop (no infrastructure involved)

A 60-minute exercise with whoever would be on call. Scenario: eu-central-1 is unavailable for 8+ hours. Walk
through, writing down who does what and what is missing:

1. Declare the incident; who decides to fail over, and with what evidence.
2. Which assets exist in eu-west-1 *today* (RDS cross-region automated backups, `app-files` replication only if
   Stage 2 added it) and which must be rebuilt (VPC, ECS, Valkey, CloudFront origin, secrets).
3. Rebuild order using Terraform (`environments/production` pointed at the recovery region): state bucket location,
   secrets (the generated `core` secret is **not** in Terraform; is the escrowed copy of the two encryption keys
   reachable without the lost region?), DNS cut-over at Route 53 / CloudFront.
4. Restore the database from the cross-region backup; expected data loss window.
5. What users see, and the communication.

Output: a dated list of gaps with owners. The usual findings are an unreachable escrow copy, secrets that exist
only in the lost region and no recent rehearsal of the Terraform rebuild.

## 5. Cost re-validation

1. Collect two weeks of staging usage from Cost Explorer grouped by the `Component` tag, and the load-test
   window separately.
2. Compare each line of plan section 6.3 with the Pricing Calculator estimate and with measured usage; investigate
   any line more than 10 % apart.
3. Replace the section 6.2 assumptions that staging can now measure (requests per user, bytes per request, log
   volume, MediaConvert minutes per content-hour) with measured values and re-derive the Low / Expected figures.
4. Confirm the budgets and anomaly monitors from Phase 2 fired in tests (a deliberate small overspend alert).

## Exit criteria

- [ ] k6 thresholds met at 500 learners (and 50 instructors) on the production-Low sizing, or the configuration
      was changed and re-tested until they are
- [ ] Hardened (read-only) root filesystem working, or the Dockerfile fixed so it does
- [ ] PITR drill executed; restore seconds and row-count comparison recorded
- [ ] Region-loss tabletop held; gap list has owners and dates
- [ ] Cost model re-run with measured staging figures; budgets adjusted

## Not covered here

* **Worker autoscaling on queue depth** needs the app to publish a queue-depth metric to CloudWatch (it does not
  yet) and a target-tracking policy on it. Until then the worker has a fixed count.
* **Production-only DR parts** (cross-region RDS backups, optional S3 replication, Backup Vault Lock) belong to
  `environments/production` in Phase 6.
