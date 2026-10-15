# AWS runtime configuration (Phase 1 outcome)

Every setting the application reads to run on AWS. Nothing here is a secret unless marked **secret**
(those come from Secrets Manager into the task definition). Defaults keep the historical single-process,
provider-as-before behaviour, so none of this changes an existing deployment until it is set.

## Process roles and HTTP

| Variable | Values / default | Notes |
|---|---|---|
| `PROCESS_ROLE` | `all` (default), `api`, `worker` | `api`: HTTP only. `worker`: queue consumers + `@Cron` jobs (HTTP stays up for health checks, unrouted). One image, role chosen per ECS service. |
| `RUN_MIGRATIONS` | `false` on services | Migrations run in the one-shot `migrate` task: `node dist/src/database/migrate-cli.js run` (advisory-locked). |
| `TRUST_PROXY_HOPS` | `1` default; **`2`** behind CloudFront + ALB (browsers reach the API host directly; the Vercel frontend is not a proxy hop) | Wrong value keys the rate limiter on edge addresses. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `125000` default | Must exceed the ALB idle timeout (120 s). Headers timeout = this + 5 s. |
| `LOG_FORMAT` | `text` default; **`json`** on AWS | One JSON object per line for CloudWatch Logs Insights. |
| `WORKER_CONCURRENCY` | `5` | Per replica. |

## TLS to data stores

| Variable | Notes |
|---|---|
| `REQUIRE_TLS_BACKENDS=true` | Boot fails unless Redis is `rediss://`, certificate verification is on, and the DB host is not loopback. Set in staging/production. |
| `REDIS_URL` | `rediss://:<auth token>@<elasticache endpoint>:6379` (**secret**). On ECS it is composed by the entrypoint from `REDIS_HOST`, `REDIS_PORT` and the secret-injected `REDIS_AUTH_TOKEN`. ElastiCache certificates chain to Amazon roots already trusted by Node. |
| `DATABASE_URL` | **secret**. Remote hosts always use SSL with verification. On ECS it is not set: the container entrypoint (`scripts/docker-entrypoint.sh`) composes it from `DB_HOST`, `DB_PORT`, `DB_NAME` and the secret-injected `DB_USER` / `DB_PASSWORD` (the `<prefix>/db-app` secret for api and worker; the RDS-managed master secret for the migrate task, which also receives `APP_DB_USER` / `APP_DB_PASSWORD` and creates that role). |
| `DATABASE_SSL_CA_FILE` / `DATABASE_SSL_CA` | RDS CA bundle (file path or PEM). Build the image with `--build-arg RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` and set `DATABASE_SSL_CA_FILE=/app/certs/rds-ca-bundle.pem`. |
| ElastiCache parameter | `maxmemory-policy=noeviction` (BullMQ requirement). |

## Object storage (S3)

| Variable | Notes |
|---|---|
| `S3_BUCKET` | Selects the S3 provider. Private bucket; objects are served through backend routes or signed URLs only. |
| `S3_REGION` / `AWS_REGION` | Default `eu-central-1`. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | **Local testing (MinIO) only; refused when `NODE_ENV=production`.** Production uses the ECS task role. |
| `VIDEO_SOURCE_BUCKET` | Private bucket for original uploads (MediaConvert input). Enables direct video uploads. |
| `DIRECT_UPLOAD_PART_SIZE_MB`, `DIRECT_UPLOAD_SINGLE_MAX_MB` | Tuning/testing knobs (defaults 64 MiB / policy maximum). |

Direct (browser-to-S3) uploads: books ≤ 200 MB, lesson resources ≤ 50 MB, lesson videos ≤ 20 GB. The browser
never sends file bytes through the API; the server re-verifies size, type and content at `complete`.
Task-role needs: `s3:PutObject/GetObject/DeleteObject/AbortMultipartUpload/ListMultipartUploadParts` on the
files and source buckets, `s3:ListBucket` on all video buckets, `s3:GetObject/PutObject/DeleteObject` on the output bucket.

## Video (MediaConvert -> CloudFront)

| Variable | Notes |
|---|---|
| `VIDEO_OUTPUT_BUCKET` | HLS output (SSE-S3, CloudFront OAC). |
| `MEDIACONVERT_ROLE_ARN` | Role MediaConvert assumes to read the source and write the output. Task role needs `mediaconvert:CreateJob/GetJob` and `iam:PassRole` on it. |
| `MEDIACONVERT_QUEUE_ARN` | Optional (default queue otherwise). |
| `MEDIA_EVENTS_QUEUE_URL` | SQS queue fed by EventBridge (`MediaConvert Job State Change`); needs a DLQ. Optional: a 5-minute reconcile cron polls `GetJob` as the fallback. |
| `CLOUDFRONT_KEY_PAIR_ID` | Public key id in the CloudFront key group for `/video/*`. |
| `CLOUDFRONT_PRIVATE_KEY` or `CLOUDFRONT_PRIVATE_KEY_B64` | **secret**. PEM private key used to sign playback cookies. |
| `CLOUDFRONT_SIGNING_ALGORITHM` | `SHA1` default; `SHA256` where the distribution supports it. |
| `VIDEO_PUBLIC_ORIGIN` | Origin serving `/video/*`: the API's CloudFront host (defaults to `BACKEND_URL`, never to `FRONTEND_URL`). The signed cookies are host-only cookies of this origin; the player on the Vercel-hosted frontend reaches it cross-origin but same-site (so `SameSite=Lax` cookies are sent) with credentials, and the CDN answers with an exact-origin CORS policy. `hls_url` in API responses is absolute on this origin. |

Playback = path-scoped signed cookies (15 minutes, one asset per grant) returned by `GET /lessons/:id/signed-url`
(and the marketplace player, free-preview and admin-review routes). Marketplace lessons store `aws:<asset id>` in `video_id`.

## Email (SES)

| Variable | Notes |
|---|---|
| `MAIL_PROVIDER` | `ses` or `mailersend` (rollback). |
| `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` | Verified SES identity. |
| `SES_REGION`, `SES_CONFIGURATION_SET` | Config set publishes bounces/complaints to SNS -> SQS. |
| `MAIL_EVENTS_QUEUE_URL` | SQS queue of SES feedback (logged + metric; SES account-level suppression does the blocking). |
| `MAIL_ALLOWLIST` | Required on staging (SES stays in the sandbox there as well). |

## SMS (AWS End User Messaging)

| Variable | Notes |
|---|---|
| `SMS_PROVIDER` | `aws`, `twilio`, `none`. Unset keeps the old rule (Twilio if its credentials exist). |
| `SMS_AWS_ORIGINATION_IDENTITY` | Registered Egypt sender ID (or pool/phone ARN). |
| `SMS_AWS_CONFIGURATION_SET`, `SMS_AWS_PROTECT_CONFIGURATION_ID` | Event destination and the Egypt-only protect configuration. |
| `SMS_ALLOWED_COUNTRY_PREFIXES` | Default `+20`; second line of defence against SMS pumping. |
| `SMS_MODE=sandbox` | Staging: nothing is sent. |
| `SMS_EVENTS_QUEUE_URL` | SQS queue of delivery events (configuration set -> SNS -> SQS). The worker logs each event (warn on failure, destination masked; CloudWatch metric `SmsDeliveryFailures`) and promotes the guardian message in `parent_messages` from `sent` to `delivered` / `failed` by `provider_message_id` (same monotonic path as the WhatsApp webhook). OTP texts are logged only. |

## Web Push

| Variable | Notes |
|---|---|
| `PUSH_PROVIDER` | `webpush` (standard, no Firebase) or unset/`fcm`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (**secret**), `VAPID_SUBJECT` (`mailto:`) | Generate once with `npx web-push generate-vapid-keys`. |

Subscription endpoints are allowlisted to real browser push services (SSRF guard) at registration and at send time.

## Observability (CloudWatch)

| Variable | Notes |
|---|---|
| `QUEUE_METRICS_NAMESPACE` | e.g. `Learnix/Queues`. Processes that run queue consumers publish `QueueBacklog` (waiting + prioritized jobs, all work queues) and `DeadLetterJobs` every 60 s with `PutMetricData`. Drives worker autoscaling (backlog per running task) and the backlog alarm. Unset = nothing published. Task role needs `cloudwatch:PutMetricData` limited to this namespace. |
| `QUEUE_METRICS_ENVIRONMENT` | Value of the `Environment` dimension (Terraform: `learnix-<env>`). |
| `OTEL_*`, `NODE_OPTIONS` | Set by Terraform when Application Signals is enabled (ADOT Node.js auto-instrumentation from an init container + CloudWatch agent sidecar). Traces go to X-Ray, RED metrics to Application Signals. When these are present, Sentry (if still configured) captures errors only and leaves the OpenTelemetry tracer to ADOT. |

Logs are one JSON object per line (`LOG_FORMAT=json`); CloudWatch metric filters count `level=error`, SMS
failures and SES bounces/complaints, and saved Logs Insights queries live under `learnix-<env>/` in the
CloudWatch console.

## Container filesystem

The image declares `VOLUME /tmp`; with `readonlyRootFilesystem` (on in staging, then production) `/tmp` is
the only writable path. Code exports are written there briefly before upload to S3.

## Release identity

`GIT_SHA` (or `APP_RELEASE`) set by the image build/task definition; `INSTANCE_ID` / `ECS_TASK_ID` optional.

## Frontend on Vercel, API on AWS (cross-origin contract)

| Variable | Value | Notes |
|---|---|---|
| `FRONTEND_URL` | `https://learnix.school` | The Vercel app. Used for reset links, payment return URLs and the backend-to-frontend health probe. |
| `BACKEND_URL` | `https://api.learnix.school` | Public API origin: Paymob/Meta/OAuth callbacks, protected download links, absolute media URLs. |
| `CORS_ORIGINS` | `https://learnix.school` | Exact-origin allowlist for credentialed requests (`buildCorsOptions` in `src/common/utils/cors.util.ts`). Must include `FRONTEND_URL`. Production validation rejects wildcards. Never list `*.vercel.app` previews on production. |
| `COOKIE_DOMAIN` | **unset** | Cookies stay host-only on the API host (`SameSite=None; Secure; Partitioned`, `HttpOnly` for the credentials). A parent-domain value would hand staging and production each other's cookies; the isolation guard refuses it. |

Frontend request flow: the browser loads pages from Vercel, then calls `https://api.<domain>/api/v1/...` with
`withCredentials`, the `X-CSRF-Token` header (value from `GET /auth/csrf-token`) and the HttpOnly cookies. The API is
same-site with the frontend (same registrable domain), so cookie behaviour does not depend on third-party-cookie
policy; preflights are answered by the API itself. The Next.js server (Vercel) calls the API only for public data
(sitemap, certificate PDF links).
