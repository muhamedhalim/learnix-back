/**
 * Cross-environment isolation guard.
 *
 * WHY THIS RUNS SO EARLY
 * ----------------------
 * This is invoked from `validate()` in `env.validation.ts`, which NestJS calls
 * inside `ConfigModule.forRoot({ validate })` — before any module is
 * instantiated, before TypeORM opens a connection, before BullMQ registers a
 * queue, and before `@nestjs/schedule` arms a single cron trigger.
 *
 * That ordering is the whole point. This application runs eleven `@Cron` jobs
 * in-process (see `docs/CRON_AUDIT.md`), three of which mutate financial state
 * and two of which delete storage objects, and the earliest of them fires
 * sixty seconds after boot. A staging instance holding one copy-pasted
 * production connection string is not a configuration mistake — it is a
 * financial incident. By the time a runtime check could notice, the
 * reconciliation sweep has already run.
 *
 * WHY NOT HOSTNAME COMPARISON ALONE
 * ---------------------------------
 * A hostname denylist only catches the mistakes you predicted the hostname
 * for. Four independent rule classes are applied instead, so no single
 * incomplete list is load-bearing:
 *
 *   1. HOST DENYLIST      — exact hostnames known to belong to production.
 *   2. IDENTIFIER DENYLIST— bucket names, video library IDs, database names:
 *                           resources that have no hostname at all.
 *   3. STRUCTURAL RULES   — the shape a staging value must have (database name
 *                           must look like staging, payment mode must be test,
 *                           mail must be allowlisted, no cookie domain).
 *   4. SECRET FINGERPRINTS— SHA-256 prefixes of production secrets, so a
 *                           pasted credential is caught even when every URL,
 *                           bucket and identifier around it is correct. Only
 *                           hashes are configured; no secret is ever stored.
 *
 * A misconfiguration must defeat all four to get through.
 *
 * REPORTING
 * ---------
 * Every violation is collected and reported together. An operator standing up
 * staging for the first time sees the complete list once, rather than
 * discovering them one failed deploy at a time.
 *
 * NO SECRET VALUE IS EVER PLACED IN AN ERROR MESSAGE OR LOG LINE.
 */

import { createHash } from 'node:crypto';

import type { EnvReader } from '../common/utils/redis-connection.util';
import { AppEnvironment, isDeployedEnv } from './app-env';

/**
 * Hostnames belonging to the production deployment.
 *
 * These are defaults, not the whole mechanism: `PROD_HOST_DENYLIST` extends
 * them per-deployment. They are hardcoded so the guard is protective out of
 * the box — an operator who forgets to configure the denylist still gets the
 * benefit rather than silently getting nothing.
 *
 * Matching is EXACT, never suffix-based. `learnix.school` is denied;
 * `staging.learnix.school` is a different host and is not.
 */
const DEFAULT_PRODUCTION_HOSTS: readonly string[] = Object.freeze([
  'learnix.school',
  'www.learnix.school',
  'app.learnix.school',
  'api.learnix.school',
  'learning-center-backend-production.up.railway.app',
]);

/** Resource identifiers (no hostname) known to belong to production. */
const DEFAULT_PRODUCTION_IDENTIFIERS: readonly string[] = Object.freeze(['learnix']);

/** Sender addresses that must never send from a non-production deployment. */
const DEFAULT_PRODUCTION_SENDERS: readonly string[] = Object.freeze([
  'info@learnix.school',
  'no-reply@learnix.school',
  'noreply@learnix.school',
]);

/** A staging database, bucket or namespace must announce itself as one. */
const STAGING_TOKEN_PATTERN = /(^|[^a-z])(staging|stg)([^a-z]|$)/i;

/** Variables whose values are compared against `PROD_SECRET_FINGERPRINTS`. */
const FINGERPRINTED_SECRETS: readonly string[] = Object.freeze([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'COOKIE_SECRET',
  'INIT_SECRET',
  'METRICS_BEARER_TOKEN',
  // A Slack/Discord-style incoming webhook URL carries its token in the path.
  // Fingerprinting it stops a staging deployment from paging the production
  // on-call channel with staging noise.
  'ALERT_WEBHOOK_URL',
  'BULL_BOARD_PASSWORD',
  'PAYMOB_API_KEY',
  'PAYMOB_SECRET_KEY',
  'PAYMOB_WEBHOOK_SECRET',
  'MAILERSEND_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_TOKEN_KEY',
  'BUNNY_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'META_WHATSAPP_ACCESS_TOKEN',
  'META_WHATSAPP_APP_SECRET',
  'FIREBASE_PRIVATE_KEY',
  'ADMIN_INIT_PASSWORD',
]);

export interface IsolationViolation {
  /** Stable machine-readable code, e.g. `STAGING_PRODUCTION_DATABASE_HOST`. */
  code: string;
  /** Which of the four rule classes caught it. */
  rule: 'host-denylist' | 'identifier-denylist' | 'structural' | 'secret-fingerprint';
  /** The offending variable. Its VALUE is never included. */
  variable: string;
  /** Operator-facing explanation and remedy. */
  message: string;
}

export class EnvironmentIsolationError extends Error {
  public readonly violations: readonly IsolationViolation[];

  public constructor(appEnv: AppEnvironment, violations: readonly IsolationViolation[]) {
    const lines = violations
      .map((violation) => `  - [${violation.code}] ${violation.variable}: ${violation.message}`)
      .join('\n');
    super(
      `Environment isolation check failed for APP_ENV=${appEnv}.\n\n${lines}\n\n` +
        'The application refused to start because it detected configuration belonging to a\n' +
        'different environment. Fix the variables above; do not bypass this check.\n' +
        'See docs/ENVIRONMENT_INVENTORY.md and STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md.',
    );
    this.name = 'EnvironmentIsolationError';
    this.violations = violations;
  }
}

/** Comma/whitespace-separated list → normalised lowercase entries. */
function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/** Hostname of a URL-ish value, lowercased and bracket/trailing-dot stripped. */
function hostOf(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return new URL(value).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  } catch {
    // Bare host (e.g. REDIS_HOST=redis.railway.internal) rather than a URL.
    return value.trim().toLowerCase().replace(/\.$/, '') || undefined;
  }
}

/** Database name from a Postgres URL (the pathname, minus its leading slash). */
function databaseNameOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? undefined : name.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Short SHA-256 prefix. Used only to COMPARE secrets, never to reveal them. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

interface RuleContext {
  get: EnvReader;
  hostDenylist: Set<string>;
  identifierDenylist: Set<string>;
  senderDenylist: Set<string>;
  secretFingerprints: Set<string>;
  violations: IsolationViolation[];
}

function deny(context: RuleContext, violation: IsolationViolation): void {
  context.violations.push(violation);
}

/** Rule class 1 + 2 helper: is this host/identifier claimed by production? */
function assertNotProductionHost(
  context: RuleContext,
  variable: string,
  code: string,
  remedy: string,
): void {
  const host = hostOf(context.get(variable));
  if (host !== undefined && context.hostDenylist.has(host)) {
    deny(context, {
      code,
      rule: 'host-denylist',
      variable,
      message: `resolves to production host "${host}". ${remedy}`,
    });
  }
}

function assertNotProductionIdentifier(
  context: RuleContext,
  variable: string,
  code: string,
  remedy: string,
): void {
  const raw = context.get(variable);
  if (raw === undefined || raw.trim() === '') return;
  if (context.identifierDenylist.has(raw.trim().toLowerCase())) {
    deny(context, {
      code,
      rule: 'identifier-denylist',
      variable,
      message: `is the production resource identifier "${raw.trim()}". ${remedy}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Staging rules
// ---------------------------------------------------------------------------

function checkDatabase(context: RuleContext): void {
  assertNotProductionHost(
    context,
    'DATABASE_URL',
    'STAGING_PRODUCTION_DATABASE_HOST',
    'Point staging at its own Postgres instance.',
  );

  const name = databaseNameOf(context.get('DATABASE_URL'));
  if (name !== undefined) {
    if (context.identifierDenylist.has(name)) {
      deny(context, {
        code: 'STAGING_PRODUCTION_DATABASE_NAME',
        rule: 'identifier-denylist',
        variable: 'DATABASE_URL',
        message: `targets the production database "${name}". Provision a separate staging database.`,
      });
    } else if (!STAGING_TOKEN_PATTERN.test(name)) {
      deny(context, {
        code: 'STAGING_DATABASE_NAME_NOT_MARKED',
        rule: 'structural',
        variable: 'DATABASE_URL',
        message:
          `database name "${name}" does not identify itself as staging. Name it so it contains ` +
          '"staging" (or "stg"), e.g. "learnix_staging", so an accidental production URL is ' +
          'structurally impossible to mistake for a correct one.',
      });
    }
  }

  // Defence in depth for a misconfigured staging deployment that somehow
  // isn't running NODE_ENV=production (the required setup — see §2.15 of the
  // plan): app.module.ts's own `isProduction && synchronize → throw` check is
  // keyed on NODE_ENV, so it would not fire in that scenario even though
  // APP_ENV correctly resolved to staging. This check is keyed on APP_ENV
  // instead, so it fires regardless of what NODE_ENV happens to be.
  if (context.get('TYPEORM_SYNCHRONIZE') === 'true') {
    deny(context, {
      code: 'STAGING_SYNCHRONIZE_ENABLED',
      rule: 'structural',
      variable: 'TYPEORM_SYNCHRONIZE',
      message:
        'must not be "true" on staging. Schema is managed exclusively by migrations outside of ' +
        'NODE_ENV=test; synchronize can silently rewrite the schema staging is meant to prove ' +
        'migrations against.',
    });
  }
}

function checkRedis(context: RuleContext): void {
  assertNotProductionHost(
    context,
    'REDIS_URL',
    'STAGING_PRODUCTION_REDIS_HOST',
    'Provision a separate staging Redis instance.',
  );
  assertNotProductionHost(
    context,
    'REDIS_HOST',
    'STAGING_PRODUCTION_REDIS_HOST',
    'Provision a separate staging Redis instance.',
  );

  // Redis has no per-environment key prefix in this codebase (see finding
  // A-12), so two environments sharing one instance would collide on every
  // queue, cache, throttle and idempotency key. When a namespace IS supplied
  // it must be a staging one; when it is absent, the host rules above are what
  // keep the instances apart.
  const namespace = context.get('REDIS_NAMESPACE');
  if (
    namespace !== undefined &&
    namespace.trim() !== '' &&
    !STAGING_TOKEN_PATTERN.test(namespace)
  ) {
    deny(context, {
      code: 'STAGING_REDIS_NAMESPACE_NOT_MARKED',
      rule: 'structural',
      variable: 'REDIS_NAMESPACE',
      message:
        `namespace "${namespace}" does not identify itself as staging. Use e.g. "staging" so ` +
        'keys can never be confused with production keys.',
    });
  }
}

/** Amazon S3 buckets: a staging deployment must not point at (or be named like) a production bucket. */
function checkS3Buckets(context: RuleContext): void {
  for (const variable of ['S3_BUCKET', 'VIDEO_SOURCE_BUCKET', 'VIDEO_OUTPUT_BUCKET']) {
    assertNotProductionIdentifier(
      context,
      variable,
      'STAGING_PRODUCTION_STORAGE_BUCKET',
      'Use the staging account\'s own bucket. The orphan-cleanup crons DELETE objects, so a shared ' +
        'bucket means staging deletes production files.',
    );
    const bucket = context.get(variable);
    if (bucket !== undefined && bucket.trim() !== '' && !STAGING_TOKEN_PATTERN.test(bucket)) {
      deny(context, {
        code: 'STAGING_STORAGE_BUCKET_NOT_MARKED',
        rule: 'structural',
        variable,
        message: `bucket "${bucket.trim()}" does not identify itself as staging. Name it e.g. "learnix-staging-files".`,
      });
    }
  }
}

function checkStorage(context: RuleContext): void {
  checkS3Buckets(context);
  assertNotProductionIdentifier(
    context,
    'R2_BUCKET',
    'STAGING_PRODUCTION_STORAGE_BUCKET',
    'Create a dedicated staging bucket and an API token scoped to it alone. ' +
      'The weekly orphan-cleanup cron DELETES objects — a shared bucket means staging deletes production files.',
  );

  // A correctly-named staging bucket living under the SAME R2 ACCOUNT as
  // production is still one IAM boundary away from safe: an over-scoped
  // token could still touch the production bucket. This does not replace a
  // properly bucket-scoped token (Phase 3 checklist), but a bucket name alone
  // does not prove the account differs, so it is checked independently.
  assertNotProductionIdentifier(
    context,
    'R2_ACCOUNT_ID',
    'STAGING_PRODUCTION_R2_ACCOUNT',
    'Provision the staging bucket under its own Cloudflare account (or at least a distinct, ' +
      'bucket-scoped API token) rather than reusing the production account ID.',
  );

  const bucket = context.get('R2_BUCKET');
  if (bucket !== undefined && bucket.trim() !== '' && !STAGING_TOKEN_PATTERN.test(bucket)) {
    deny(context, {
      code: 'STAGING_STORAGE_BUCKET_NOT_MARKED',
      rule: 'structural',
      variable: 'R2_BUCKET',
      message:
        `bucket "${bucket.trim()}" does not identify itself as staging. Name it e.g. ` +
        '"learnix-staging".',
    });
  }

  assertNotProductionIdentifier(
    context,
    'BUNNY_STREAM_LIBRARY_ID',
    'STAGING_PRODUCTION_VIDEO_LIBRARY',
    'Create a separate Bunny Stream library for staging; lesson replacement DELETES videos.',
  );
  assertNotProductionHost(
    context,
    'BUNNY_STREAM_CDN_HOSTNAME',
    'STAGING_PRODUCTION_VIDEO_CDN',
    'Use the staging library pull zone.',
  );

  // Parity with the production rule in storage.service.ts:392 — R2 objects
  // include paid books and OMR sheets and must never be publicly addressable.
  const publicBase = context.get('R2_PUBLIC_BASE_URL');
  if (publicBase !== undefined && publicBase.trim() !== '') {
    deny(context, {
      code: 'STAGING_R2_PUBLIC_BASE_URL_SET',
      rule: 'structural',
      variable: 'R2_PUBLIC_BASE_URL',
      message:
        'must be unset. Production refuses to boot with it set (storage.service.ts) because R2 ' +
        'holds paid and private objects; staging mirrors that rule.',
    });
  }
}

function checkPayments(context: RuleContext): void {
  const configured = (context.get('PAYMOB_API_KEY') ?? '').trim() !== '';
  const mode = (context.get('PAYMOB_EXPECTED_MODE') ?? '').trim().toLowerCase();

  if (configured && mode !== 'test') {
    deny(context, {
      code: 'STAGING_PAYMENT_MODE_NOT_TEST',
      rule: 'structural',
      variable: 'PAYMOB_EXPECTED_MODE',
      message:
        'must be exactly "test" when Paymob credentials are configured on staging. ' +
        `Received "${mode === '' ? '<unset>' : mode}". Without this, paymob.gateway.ts treats the ` +
        'deployment as live and real charges become possible.',
    });
  }

  // PAYMOB_EXPECTED_MODE is this application's OWN belief about the
  // transaction; whether a transaction is actually live-money or sandbox is
  // decided by Paymob, keyed off which INTEGRATION reference this deployment
  // submits. A staging box using Production's real card-integration or
  // iframe ID would submit genuinely live-capable transactions to Paymob
  // regardless of what PAYMOB_EXPECTED_MODE says — `assertProviderMode`
  // would only notice (and reject) the mismatch *after* Paymob has already
  // processed it. These identifiers must therefore be checked independently
  // of the mode flag, the same way a bucket or video-library ID is.
  assertNotProductionIdentifier(
    context,
    'PAYMOB_CARD_INTEGRATION_ID',
    'STAGING_PRODUCTION_PAYMENT_INTEGRATION',
    "Use the TEST merchant account's own card-integration ID. Reusing the production " +
      'integration ID lets Paymob process a genuinely live-capable transaction no matter what ' +
      'PAYMOB_EXPECTED_MODE says.',
  );
  assertNotProductionIdentifier(
    context,
    'PAYMOB_IFRAME_ID',
    'STAGING_PRODUCTION_PAYMENT_INTEGRATION',
    "Use the TEST merchant account's own iframe ID, for the same reason as the card-integration ID.",
  );
}

function checkWebhooksAndOrigins(context: RuleContext): void {
  for (const variable of [
    'FRONTEND_URL',
    'BACKEND_URL',
    'PUBLIC_MEDIA_BASE_URL',
    'CODE_REDEEM_BASE_URL',
  ]) {
    assertNotProductionHost(
      context,
      variable,
      'STAGING_PRODUCTION_ORIGIN',
      'Use the staging origin. Webhook, media-proxy and redemption URLs are built from these.',
    );
  }

  for (const origin of parseList(context.get('CORS_ORIGINS'))) {
    const host = hostOf(origin);
    if (host !== undefined && context.hostDenylist.has(host)) {
      deny(context, {
        code: 'STAGING_PRODUCTION_CORS_ORIGIN',
        rule: 'host-denylist',
        variable: 'CORS_ORIGINS',
        message:
          `includes production origin "${host}". Staging must not accept credentialed requests ` +
          'from the production frontend.',
      });
    }
  }
}

function checkCookies(context: RuleContext): void {
  // This codebase never sets a cookie `domain`, which is precisely why
  // production and staging cookies cannot collide (finding A-16). If a
  // COOKIE_DOMAIN is ever introduced, a parent-domain value would hand staging
  // cookies to production and vice versa.
  const domain = context.get('COOKIE_DOMAIN');
  if (domain === undefined || domain.trim() === '') return;

  const normalized = domain.trim().toLowerCase().replace(/^\./, '');
  if (context.hostDenylist.has(normalized) || !STAGING_TOKEN_PATTERN.test(normalized)) {
    deny(context, {
      code: 'STAGING_PRODUCTION_COOKIE_DOMAIN',
      rule: 'structural',
      variable: 'COOKIE_DOMAIN',
      message:
        `"${domain.trim()}" would scope staging cookies to a domain shared with production. ` +
        'Leave COOKIE_DOMAIN unset — host-only cookies are what keeps the environments separate.',
    });
  }
}

function checkMessaging(context: RuleContext): void {
  const mailProvider = (context.get('MAIL_PROVIDER') ?? '').trim().toLowerCase();
  const mailEnabled = mailProvider === 'mailersend' || mailProvider === 'ses';
  // SES authenticates through the task role, so being selected is what makes it live.
  const mailKeyPresent =
    mailProvider === 'ses' || (context.get('MAILERSEND_API_KEY') ?? '').trim() !== '';

  if (mailEnabled && mailKeyPresent && parseList(context.get('MAIL_ALLOWLIST')).length === 0) {
    deny(context, {
      code: 'STAGING_MAIL_ALLOWLIST_MISSING',
      rule: 'structural',
      variable: 'MAIL_ALLOWLIST',
      message:
        'is required when an email provider (SES or MailerSend) is configured on staging. Without it, any address present in ' +
        'the database receives real mail. Set a comma-separated list of permitted recipients or domains.',
    });
  }

  const sender = (context.get('MAIL_FROM_EMAIL') ?? '').trim().toLowerCase();
  if (sender !== '' && context.senderDenylist.has(sender)) {
    deny(context, {
      code: 'STAGING_PRODUCTION_MAIL_SENDER',
      rule: 'identifier-denylist',
      variable: 'MAIL_FROM_EMAIL',
      message:
        `"${sender}" is a production sender address. Use a distinct staging sender so recipients ` +
        'can always tell the environments apart.',
    });
  }

  const smsConfigured =
    (context.get('TWILIO_AUTH_TOKEN') ?? '').trim() !== '' ||
    (context.get('META_WHATSAPP_ACCESS_TOKEN') ?? '').trim() !== '';
  const smsMode = (context.get('SMS_MODE') ?? '').trim().toLowerCase();

  if (smsConfigured && smsMode !== 'sandbox') {
    deny(context, {
      code: 'STAGING_SMS_MODE_NOT_SANDBOX',
      rule: 'structural',
      variable: 'SMS_MODE',
      message:
        'must be "sandbox" when SMS or WhatsApp credentials are configured on staging, so guardian ' +
        `messages cannot reach real parents. Received "${smsMode === '' ? '<unset>' : smsMode}".`,
    });
  }

  // Meta requires WhatsApp senders to be pre-registered phone numbers; using
  // production's real phone_number_id would let staging send from the real
  // business number, indistinguishable from production to the recipient,
  // regardless of SMS_MODE (that flag is enforced in the channel registry,
  // not by Meta — see mail/sms-sandbox.util.ts).
  assertNotProductionIdentifier(
    context,
    'META_WHATSAPP_PHONE_NUMBER_ID',
    'STAGING_PRODUCTION_WHATSAPP_NUMBER',
    'Use a Meta test phone number for staging. Sending from the production phone_number_id would ' +
      'reach real recipients from the real business number.',
  );

  // Firebase's only current use in this codebase is verifying ID tokens
  // (src/users/users.service.ts's syncFirebaseUser) — not push notifications,
  // whatever the .env.example section heading suggests. Still worth keeping
  // staging on its own Firebase project: a shared project means a token
  // minted by the production mobile app would authenticate on staging too.
  assertNotProductionIdentifier(
    context,
    'FIREBASE_PROJECT_ID',
    'STAGING_PRODUCTION_FIREBASE_PROJECT',
    'Use a separate Firebase project for staging so ID tokens are not valid across environments.',
  );
}

function checkSecretFingerprints(context: RuleContext): void {
  if (context.secretFingerprints.size === 0) return;

  for (const variable of FINGERPRINTED_SECRETS) {
    const value = context.get(variable);
    if (value === undefined || value.trim() === '') continue;
    if (context.secretFingerprints.has(fingerprint(value))) {
      deny(context, {
        code: 'STAGING_PRODUCTION_SECRET_REUSED',
        rule: 'secret-fingerprint',
        variable,
        message:
          'matches a fingerprint listed in PROD_SECRET_FINGERPRINTS, meaning a production ' +
          'credential has been configured on staging. Generate a distinct staging value.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Production mirror rules
// ---------------------------------------------------------------------------

/**
 * The inverse guard: staging-shaped configuration must never reach production.
 * These are additive and cannot break the currently-deployed service, because
 * every variable they inspect is either already required to hold the opposite
 * value (`PAYMOB_EXPECTED_MODE`, enforced by `env.validation.ts`) or is newly
 * introduced by this phase and therefore unset in production today.
 */
function checkProductionMirror(context: RuleContext): void {
  const mode = (context.get('PAYMOB_EXPECTED_MODE') ?? '').trim().toLowerCase();
  if (mode === 'test') {
    deny(context, {
      code: 'PRODUCTION_PAYMENT_MODE_IS_TEST',
      rule: 'structural',
      variable: 'PAYMOB_EXPECTED_MODE',
      message: 'is "test" on a production deployment. Real payments would not be processed.',
    });
  }

  if (parseList(context.get('MAIL_ALLOWLIST')).length > 0) {
    deny(context, {
      code: 'PRODUCTION_MAIL_ALLOWLIST_SET',
      rule: 'structural',
      variable: 'MAIL_ALLOWLIST',
      message:
        'is a staging-only control. On production it would silently discard mail to every ' +
        'customer not on the list. Unset it.',
    });
  }

  if ((context.get('SMS_MODE') ?? '').trim().toLowerCase() === 'sandbox') {
    deny(context, {
      code: 'PRODUCTION_SMS_MODE_IS_SANDBOX',
      rule: 'structural',
      variable: 'SMS_MODE',
      message: 'is "sandbox" on production. Guardian notifications would never be delivered.',
    });
  }

  // The mirror of STAGING_DATABASE_NAME_NOT_MARKED / STAGING_REDIS_NAMESPACE_NOT_MARKED:
  // a production deployment accidentally pointed at (or labelled as) a
  // staging resource is exactly as dangerous as the reverse — teachers and
  // students would be served by what everyone believes is the scratch
  // environment.
  const databaseName = databaseNameOf(context.get('DATABASE_URL'));
  if (databaseName !== undefined && STAGING_TOKEN_PATTERN.test(databaseName)) {
    deny(context, {
      code: 'PRODUCTION_DATABASE_NAME_LOOKS_LIKE_STAGING',
      rule: 'structural',
      variable: 'DATABASE_URL',
      message:
        `database name "${databaseName}" identifies itself as staging, but APP_ENV resolves to ` +
        'production. Verify DATABASE_URL — this looks like a staging database reached by a ' +
        'production deployment.',
    });
  }

  const redisNamespace = (context.get('REDIS_NAMESPACE') ?? '').trim();
  if (redisNamespace !== '' && STAGING_TOKEN_PATTERN.test(redisNamespace)) {
    deny(context, {
      code: 'PRODUCTION_REDIS_NAMESPACE_LOOKS_LIKE_STAGING',
      rule: 'structural',
      variable: 'REDIS_NAMESPACE',
      message:
        `"${redisNamespace}" identifies itself as staging, but APP_ENV resolves to production. ` +
        'Unset REDIS_NAMESPACE on production or point it at a production-shaped value.',
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the isolation rules for the resolved environment.
 *
 * Development and test deployments are exempt: they are not user-facing, and a
 * developer pointing at a scratch database with an unmarked name is not an
 * incident. Only `staging` and `production` are gated.
 *
 * @throws {EnvironmentIsolationError} listing every violation found.
 */
export function assertEnvironmentIsolation(appEnv: AppEnvironment, get: EnvReader): void {
  if (!isDeployedEnv(appEnv)) return;

  const context: RuleContext = {
    get,
    hostDenylist: new Set([
      ...DEFAULT_PRODUCTION_HOSTS,
      ...parseList(get('PROD_HOST_DENYLIST')),
      // Backwards-compatible alias used in the implementation plan.
      ...parseList(get('PROD_RESOURCE_DENYLIST')),
    ]),
    identifierDenylist: new Set([
      ...DEFAULT_PRODUCTION_IDENTIFIERS,
      ...parseList(get('PROD_IDENTIFIER_DENYLIST')),
      ...parseList(get('PROD_RESOURCE_DENYLIST')),
    ]),
    senderDenylist: new Set([
      ...DEFAULT_PRODUCTION_SENDERS,
      ...parseList(get('PROD_SENDER_DENYLIST')),
    ]),
    secretFingerprints: new Set(parseList(get('PROD_SECRET_FINGERPRINTS'))),
    violations: [],
  };

  if (appEnv === AppEnvironment.Staging) {
    checkDatabase(context);
    checkRedis(context);
    checkStorage(context);
    checkPayments(context);
    checkWebhooksAndOrigins(context);
    checkCookies(context);
    checkMessaging(context);
    checkSecretFingerprints(context);
  } else {
    checkProductionMirror(context);
  }

  if (context.violations.length > 0) {
    throw new EnvironmentIsolationError(appEnv, context.violations);
  }
}

/** Raised by `assertTestDatabaseIsSafe` when the test runner's `DATABASE_URL`
 * or `REDIS_URL` resolves to a known production (or explicitly denylisted)
 * host. */
export class UnsafeTestDatabaseError extends Error {
  public constructor(variable: string, host: string) {
    super(
      `Refusing to run the test suite: ${variable} resolves to "${host}", which is a known ` +
        'production host. Point the test runner at a disposable database instead ' +
        '(see test/.env.test).',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

/**
 * The narrow counterpart to `assertEnvironmentIsolation` for `NODE_ENV=test`:
 * `assertEnvironmentIsolation` deliberately exempts test runs entirely (a
 * developer's scratch database legitimately has no "test" marker to check
 * for), but a test suite that TRUNCATEs and reseeds its target database on
 * every run must never be able to reach a production host by accident — e.g.
 * a stray `DATABASE_URL` left over in a shell session. This checks only the
 * one thing that matters for that specific danger: the host is not a known
 * production host. It intentionally does not require a "test" marker in the
 * name, since `test/.env.test`'s disposable database does not follow the
 * staging naming convention.
 *
 * No-op when `NODE_ENV !== 'test'` — this guard exists only for the test
 * runner's own entrypoint, not for general application boot.
 */
export function assertTestDatabaseIsSafe(get: EnvReader): void {
  if (get('NODE_ENV') !== 'test') return;

  const hostDenylist = new Set([
    ...DEFAULT_PRODUCTION_HOSTS,
    ...parseList(get('PROD_HOST_DENYLIST')),
    ...parseList(get('PROD_RESOURCE_DENYLIST')),
  ]);

  for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
    const host = hostOf(get(variable));
    if (host !== undefined && hostDenylist.has(host)) {
      throw new UnsafeTestDatabaseError(variable, host);
    }
  }
}
