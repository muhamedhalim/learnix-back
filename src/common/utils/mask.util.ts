/**
 * Masking helpers for logs. Keep just enough of a value to be useful for
 * debugging while never emitting full PII / secrets.
 */

/** `john.doe@example.com` → `jo***@example.com`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email === '') return null;
  const [local, domain] = email.split('@');
  if (local === undefined || domain === undefined) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Keep only the last 3 digits: `+201234567` → `***567`. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined || phone === '') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 3) return '***';
  return `***${digits.slice(-3)}`;
}

/** Fully redact a secret/token, keeping only a short prefix for correlation. */
export function maskSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${value.slice(0, 4)}…(${value.length.toString()} chars)`;
}
