/**
 * Runtime enforcement for outbound mail/SMS/WhatsApp on staging — Phase 3
 * (Storage and third-party integrations).
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * `MAIL_ALLOWLIST` and `SMS_MODE=sandbox` were already REQUIRED at boot by
 * `environment-isolation.guard.ts` whenever real SES/Twilio/Meta
 * credentials are configured on staging — but until this file, nothing in
 * `mail.service.ts`, `sms.channel.ts`, or `whatsapp-meta.channel.ts` actually
 * read those variables to change behaviour. An operator could set
 * `MAIL_ALLOWLIST` correctly and it would have zero effect: the boot guard
 * only checked that the variable was *present*, not that anything *used* it.
 * This file is the missing enforcement, kept in one place so mail and
 * SMS/WhatsApp share one allowlist-matching implementation rather than two
 * independently-maintained copies.
 *
 * SEMANTICS — mirrors the mail allowlist's already-documented intent
 * ---------------------------------------------------------------------
 * On staging: a recipient ON the allowlist receives the REAL message (this is
 * how a UAT tester's own phone/inbox gets a real test message). A recipient
 * NOT on the allowlist is blocked outright — no provider call is made, the
 * intended send is logged (recipient masked, no message content), and the
 * caller treats this as a deliberate no-op rather than a failure (so it is
 * never retried by a queue). On production, this file is fully inert: every
 * function below returns "not blocked" unconditionally.
 */

import { AppEnvironment, resolveAppEnv } from '../../config/app-env';
import type { EnvReader } from './redis-connection.util';
import { maskEmail, maskPhone } from './mask.util';

const STAGING_SUBJECT_PREFIX = '[STAGING] ';

function isStagingDeployment(get: EnvReader): boolean {
  return resolveAppEnv(get) === AppEnvironment.Staging;
}

function parseAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

export interface MessagingBlockDecision {
  /** True when this staging deployment must not actually contact the provider. */
  blocked: boolean;
  /** Present only when `blocked` is true. Safe to log — never includes the recipient. */
  reason?: string;
}

/**
 * Email: allowed if the exact address OR its domain appears in
 * `MAIL_ALLOWLIST`. Always allowed on production (this function is inert
 * there) and always allowed when `APP_ENV` is not `staging` at all (test/dev
 * developer boxes are not this file's concern — `MailService` is already
 * usually left unconfigured there).
 */
export function evaluateMailRecipient(get: EnvReader, address: string): MessagingBlockDecision {
  if (!isStagingDeployment(get)) return { blocked: false };

  const normalized = address.trim().toLowerCase();
  const domain = normalized.split('@')[1];
  const allowlist = parseAllowlist(get('MAIL_ALLOWLIST'));
  const allowed = allowlist.some(
    (entry) => entry === normalized || (domain !== undefined && entry === domain),
  );
  if (allowed) return { blocked: false };
  return {
    blocked: true,
    reason: `recipient ${maskEmail(address) ?? '<invalid>'} not in MAIL_ALLOWLIST`,
  };
}

/** Prefixes a subject with `[STAGING] ` on staging; returns it unchanged everywhere else. Idempotent. */
export function applyStagingSubjectPrefix(get: EnvReader, subject: string): string {
  if (!isStagingDeployment(get)) return subject;
  return subject.startsWith(STAGING_SUBJECT_PREFIX)
    ? subject
    : `${STAGING_SUBJECT_PREFIX}${subject}`;
}

/**
 * SMS AND WhatsApp share this one check: allowed if the exact E.164 phone
 * number appears in `SMS_ALLOWLIST` (one allowlist for both channels, since
 * they address the same guardian phone numbers). Same allow-if-listed,
 * block-otherwise semantics as mail.
 */
export function evaluatePhoneRecipient(get: EnvReader, phoneE164: string): MessagingBlockDecision {
  if (!isStagingDeployment(get)) return { blocked: false };

  const normalized = phoneE164.trim();
  const allowlist = parseAllowlist(get('SMS_ALLOWLIST'));
  const allowed = allowlist.includes(normalized.toLowerCase());
  if (allowed) return { blocked: false };
  return {
    blocked: true,
    reason: `recipient ${maskPhone(normalized) ?? '<invalid>'} not in SMS_ALLOWLIST`,
  };
}
