/**
 * Computes SHA-256 fingerprints of the secrets currently configured in this
 * process's environment — never their values.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/SECRET_ROTATION_CHECKLIST.md` documents WHERE each secret is used and
 * WHETHER it needs rotation, but had no way to show WHICH concrete value is
 * currently deployed without printing the value itself. A fingerprint closes
 * that gap: it's a one-way, non-reversible identifier (same construction the
 * isolation guard already uses for `PROD_SECRET_FINGERPRINTS` — see
 * `environment-isolation.guard.ts`'s `fingerprint()`), so two people can
 * confirm "yes, that's the same secret" or "no, that's been rotated" without
 * either of them ever seeing or transmitting the actual value.
 *
 * DOUBLES AS A SETUP TOOL: whatever this prints for the PRODUCTION environment
 * is exactly what belongs in the STAGING deployment's `PROD_SECRET_FINGERPRINTS`
 * variable (Phase 3/4), so a production secret can be structurally blocked
 * from ever being pasted into staging.
 *
 * A NOTE ON WHAT A FINGERPRINT DOES NOT PROTECT AGAINST
 * -------------------------------------------------------
 * SHA-256 truncated to 64 bits is not reversible for a genuinely
 * high-entropy secret (JWT_SECRET, COOKIE_SECRET, API keys). It offers much
 * weaker protection for a LOW-entropy, human-chosen value — a password an
 * attacker could plausibly guess and hash themselves for comparison. This
 * script flags every such variable so it is never mistaken for equally safe
 * to publish.
 *
 * USAGE
 *   npm run fingerprint:secrets            (reads process.env / .env)
 */

import { config as loadDotenv } from 'dotenv';

import { fingerprint } from '../src/config/environment-isolation.guard';

loadDotenv();

interface SecretDescriptor {
  variable: string;
  usedAt: string;
  service: string;
  /** Human-chosen values are unsafe to fingerprint for public disclosure. */
  lowEntropy?: boolean;
}

const SECRETS: readonly SecretDescriptor[] = [
  { variable: 'JWT_SECRET', usedAt: 'src/config/env.validation.ts', service: 'none (self-issued)' },
  {
    variable: 'JWT_REFRESH_SECRET',
    usedAt: 'src/config/env.validation.ts',
    service: 'none (self-issued)',
  },
  {
    variable: 'COOKIE_SECRET',
    usedAt: 'src/main.ts, src/common/guards/csrf.guard.ts',
    service: 'none',
  },
  { variable: 'INIT_SECRET', usedAt: 'src/config/env.validation.ts', service: 'none' },
  {
    variable: 'METRICS_BEARER_TOKEN',
    usedAt: 'src/observability/metrics-bearer.guard.ts',
    service: 'none',
  },
  {
    variable: 'BULL_BOARD_PASSWORD',
    usedAt: 'src/queues/bull-board-auth.middleware.ts',
    service: 'none',
  },
  {
    variable: 'EASYKASH_API_KEY',
    usedAt: 'src/payments/providers/easykash/easykash.gateway.ts',
    service: 'EasyKash',
  },
  {
    variable: 'EASYKASH_HMAC_SECRET',
    usedAt: 'src/payments/providers/easykash/easykash.gateway.ts',
    service: 'EasyKash',
  },
  {
    variable: 'R2_ACCESS_KEY_ID',
    usedAt: 'src/storage/storage.service.ts',
    service: 'Cloudflare R2',
  },
  {
    variable: 'R2_SECRET_ACCESS_KEY',
    usedAt: 'src/storage/storage.service.ts',
    service: 'Cloudflare R2',
  },
  {
    variable: 'TWILIO_AUTH_TOKEN',
    usedAt: 'src/notifications/channels/sms.channel.ts',
    service: 'Twilio',
  },
  {
    variable: 'META_WHATSAPP_ACCESS_TOKEN',
    usedAt: 'src/notifications/channels/whatsapp-meta.channel.ts',
    service: 'Meta',
  },
  {
    variable: 'META_WHATSAPP_APP_SECRET',
    usedAt: 'src/config/env.validation.ts',
    service: 'Meta',
  },
  {
    variable: 'FIREBASE_PRIVATE_KEY',
    usedAt: 'src/firebase/, src/config/env.validation.ts',
    service: 'Firebase',
  },
  {
    variable: 'ADMIN_INIT_PASSWORD',
    usedAt: 'src/admin-init/admin-initialization.service.ts',
    service: 'none',
    lowEntropy: true,
  },
];

function main(): void {
  process.stdout.write('| Variable | Present | Fingerprint | Notes |\n');
  process.stdout.write('|---|---|---|---|\n');
  for (const secret of SECRETS) {
    const value = process.env[secret.variable];
    const present = value !== undefined && value.trim() !== '';
    const digest = present ? fingerprint(value) : '—';
    const note = secret.lowEntropy
      ? 'LOW ENTROPY — do not treat this fingerprint as safe against a targeted guess; rotate regardless.'
      : '';
    process.stdout.write(
      `| \`${secret.variable}\` | ${present ? 'yes' : 'NOT SET'} | \`${digest}\` | ${note} |\n`,
    );
  }
}

main();
