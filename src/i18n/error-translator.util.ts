import type { Request } from 'express';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';

/**
 * Bilingual error-message infrastructure. English remains the canonical
 * string baked into every exception/DTO decorator/response body (unchanged
 * call sites, and — critically — `Error.message` / `.toThrow()` assertions
 * in existing tests, keep working exactly as before); Arabic is layered on
 * top via three mechanisms:
 *
 * 1. `bi(en, ar)` — for class-validator `message:` decorator options, which
 *    must be a plain string. Packs both strings into one, separated by a
 *    control character that can never appear in normal text.
 *    `translateMessage` splits it back apart based on the resolved request
 *    locale (used for the class-validator error array, where each element
 *    is just a string).
 * 2. `biBody(en, ar)` — for thrown `HttpException`s and plain JSON response
 *    bodies that carry a `message` field. Returns `{ message: en, message_ar:
 *    ar }`. NestJS's `HttpException` keeps `.message` as the plain English
 *    string when constructed with this object (verified: `new
 *    UnauthorizedException(biBody(...)).message === en`), so nothing that
 *    reads `.message` — tests, logs, Sentry — ever sees the Arabic half or a
 *    marker character. `translateBody` (used by the exception filter and
 *    the response-localization interceptor) picks the right side for the
 *    outgoing JSON and drops `message_ar` from the response.
 * 3. Pattern matching — class-validator's *default* (un-overridden) English
 *    messages follow a small, fixed set of phrasings (`"x should not be
 *    empty"`, `"x must be a string"`, …). `translateMessage` recognises the
 *    common ones and re-renders them in Arabic, preserving the interpolated
 *    property name/numbers, without requiring every DTO decorator to be
 *    touched individually.
 *
 * Anything that matches neither falls back to the original English string —
 * the same "never blank, degrade to English" contract `LocalizedContentUtil`
 * already established for content fields.
 */

const BILINGUAL_SEPARATOR = '␟';

/** Pack an English/Arabic pair into a single string for a DTO `message:` option. */
export function bi(en: string, ar: string): string {
  return `${en}${BILINGUAL_SEPARATOR}${ar}`;
}

/**
 * Build a `{ message, message_ar }` pair for a thrown `HttpException` or a
 * plain JSON response body. `.message` on the resulting exception stays the
 * plain English string — see the module doc comment.
 */
export function biBody(en: string, ar: string): { message: string; message_ar: string } {
  return { message: en, message_ar: ar };
}

/**
 * Resolve the locale-appropriate `message` for a response body produced by
 * `biBody`, stripping the `message_ar` field from the outgoing JSON either
 * way. Bodies without a `message_ar` sibling pass through unchanged.
 */
export function translateBody<T extends Record<string, unknown>>(
  body: T,
  locale: PreferredLanguage,
): T {
  const messageAr = body['message_ar'];
  if (typeof body['message'] !== 'string' || typeof messageAr !== 'string') {
    return body;
  }

  const { message_ar: _messageAr, ...rest } = body as T & { message_ar: string };
  return {
    ...rest,
    message: locale === PreferredLanguage.AR ? messageAr : (body['message'] as string),
  } as unknown as T;
}

/** Resolve the requester's locale from the `Accept-Language` header (no auth required). */
export function resolveRequestLocale(request: Request): PreferredLanguage {
  const header = request.headers['accept-language'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.toLowerCase().startsWith('ar') ? PreferredLanguage.AR : PreferredLanguage.EN;
}

interface PatternRule {
  pattern: RegExp;
  render: (match: RegExpMatchArray) => string;
}

// Generic re-renderers for class-validator's built-in English default
// messages. Each pattern captures the property name (and any numeric
// constraint argument) so the Arabic output stays accurate for any field.
const VALIDATION_PATTERNS: PatternRule[] = [
  {
    pattern: /^(.+) should not be empty$/,
    render: (m) => `يجب ألا يكون ${m[1]} فارغًا`,
  },
  {
    pattern: /^(.+) must be a string$/,
    render: (m) => `يجب أن يكون ${m[1]} نصًا`,
  },
  {
    pattern: /^(.+) must be a valid email$/,
    render: (m) => `يجب أن يكون ${m[1]} بريدًا إلكترونيًا صالحًا`,
  },
  {
    pattern: /^(.+) must be a number.*$/,
    render: (m) => `يجب أن يكون ${m[1]} رقمًا`,
  },
  {
    pattern: /^(.+) must be an integer number$/,
    render: (m) => `يجب أن يكون ${m[1]} رقمًا صحيحًا`,
  },
  {
    pattern: /^(.+) must be a boolean value$/,
    render: (m) => `يجب أن يكون ${m[1]} قيمة منطقية`,
  },
  {
    pattern: /^(.+) must be an array$/,
    render: (m) => `يجب أن يكون ${m[1]} مصفوفة`,
  },
  {
    pattern: /^(.+) must be a UUID$/,
    render: (m) => `يجب أن يكون ${m[1]} معرّفًا صالحًا (UUID)`,
  },
  {
    pattern: /^(.+) must be longer than or equal to (\d+) characters$/,
    render: (m) => `يجب ألا يقل طول ${m[1]} عن ${m[2]} حرفًا`,
  },
  {
    pattern: /^(.+) must be shorter than or equal to (\d+) characters$/,
    render: (m) => `يجب ألا يزيد طول ${m[1]} عن ${m[2]} حرفًا`,
  },
  {
    pattern: /^(.+) must not be less than (-?\d+(\.\d+)?)$/,
    render: (m) => `يجب ألا يقل ${m[1]} عن ${m[2]}`,
  },
  {
    pattern: /^(.+) must not be greater than (-?\d+(\.\d+)?)$/,
    render: (m) => `يجب ألا يزيد ${m[1]} عن ${m[2]}`,
  },
  {
    pattern: /^(.+) must be a positive number$/,
    render: (m) => `يجب أن يكون ${m[1]} رقمًا موجبًا`,
  },
  {
    pattern: /^(.+) must be a valid ISO 8601 date string$/,
    render: (m) => `يجب أن يكون ${m[1]} تاريخًا صالحًا`,
  },
  {
    pattern: /^each value in (.+) must be a valid enum value$/,
    render: (m) => `يجب أن تكون كل قيمة في ${m[1]} قيمة صالحة`,
  },
  {
    pattern: /^(.+) must be a valid enum value$/,
    render: (m) => `يجب أن يكون ${m[1]} قيمة صالحة`,
  },
  {
    pattern: /^(.+) should not be null or undefined$/,
    render: (m) => `يجب ألا يكون ${m[1]} فارغًا`,
  },
];

/**
 * Translate a single rendered message string for the given locale. English
 * requests (or unrecognised/un-marked strings) pass through unchanged.
 */
export function translateMessage(message: string, locale: PreferredLanguage): string {
  if (locale !== PreferredLanguage.AR) {
    return message.includes(BILINGUAL_SEPARATOR)
      ? (message.split(BILINGUAL_SEPARATOR)[0] ?? message)
      : message;
  }

  if (message.includes(BILINGUAL_SEPARATOR)) {
    const [, ar] = message.split(BILINGUAL_SEPARATOR);
    return ar ?? message;
  }

  for (const rule of VALIDATION_PATTERNS) {
    const match = message.match(rule.pattern);
    if (match) return rule.render(match);
  }

  return message;
}

/** Translate every element of a validation-error message array. */
export function translateMessages(messages: string[], locale: PreferredLanguage): string[] {
  return messages.map((m) => translateMessage(m, locale));
}
