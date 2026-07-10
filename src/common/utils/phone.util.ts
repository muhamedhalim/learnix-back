/**
 * Phone number normalisation to E.164.
 *
 * The platform stores every phone number in E.164 (`+<country><subscriber>`) so
 * that `01012345678`, `201012345678` and `+20 101 234 5678` collapse to a single
 * canonical string. Storing the canonical form is what makes a UNIQUE index on
 * a guardian's phone meaningful — without it the same parent can be inserted
 * several times under different spellings.
 *
 * Scope: Egypt (`+20`) is the platform's home country and the only one whose
 * national format we accept without a country code. Numbers already carrying a
 * `+` are accepted for any country provided they look like E.164. This keeps
 * the util honest — it does not pretend to validate every national numbering
 * plan on earth.
 */

/** Egyptian mobile prefixes after the leading zero: 010/011/012/015. */
const EG_MOBILE_NATIONAL = /^01[0125]\d{8}$/;

/** Egyptian mobile in international form, without the `+`. */
const EG_MOBILE_INTERNATIONAL = /^201[0125]\d{8}$/;

/** Generic E.164: `+`, a non-zero leading digit, then 7–14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Thrown when a caller-supplied phone number cannot be canonicalised. */
export class InvalidPhoneNumberError extends Error {
  public constructor() {
    // Deliberately free of the offending value — this message reaches API
    // clients and logs, and the raw number is PII.
    super('Phone number is not a valid mobile number');
    this.name = 'InvalidPhoneNumberError';
  }
}

/** Strip spaces, dashes, parentheses and Arabic-Indic digits → ASCII digits. */
function canonicaliseDigits(raw: string): string {
  return raw
    .replaceAll(/[\s\-()]/g, '')
    .replaceAll(/[٠-٩]/g, (d) => String(d.codePointAt(0)! - 0x06_60))
    .replaceAll(/[۰-۹]/g, (d) => String(d.codePointAt(0)! - 0x06_F0));
}

/**
 * Normalise a raw phone number to E.164, or `null` when it cannot be.
 *
 * Accepts (Egypt): `01012345678`, `201012345678`, `+201012345678`, and the same
 * with separators or Arabic-Indic digits. Accepts any other country only when
 * already written in valid E.164.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const cleaned = canonicaliseDigits(raw.trim());
  if (cleaned === '') return null;

  if (cleaned.startsWith('+')) {
    const candidate = cleaned;
    return E164.test(candidate) ? candidate : null;
  }

  if (EG_MOBILE_NATIONAL.test(cleaned)) return `+20${cleaned.slice(1)}`;
  if (EG_MOBILE_INTERNATIONAL.test(cleaned)) return `+${cleaned}`;

  return null;
}

/** Like {@link toE164} but throws {@link InvalidPhoneNumberError} instead of returning null. */
export function toE164OrThrow(raw: string): string {
  const normalised = toE164(raw);
  if (normalised === null) throw new InvalidPhoneNumberError();
  return normalised;
}

/** True when `value` is already a canonical E.164 string. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * True when the number is an Egyptian mobile. WhatsApp/SMS deliverability
 * checks use this to avoid dispatching to landlines and short codes.
 */
export function isEgyptianMobile(e164: string): boolean {
  return /^\+201[0125]\d{8}$/.test(e164);
}
