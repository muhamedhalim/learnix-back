import { randomBytes } from 'crypto';

/** Unambiguous alphabet (no 0/O/1/I) for human-readable codes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/**
 * Human-readable certificate number, e.g. `CERT-2026-AB3D9K`.
 * Not a security token — it's a friendly reference printed on the certificate.
 */
export function generateCertificateNumber(year = new Date().getFullYear()): string {
  return `CERT-${year.toString()}-${randomCode(6)}`;
}

/**
 * Verification code used by the public verification page. 10 unambiguous chars
 * of ~50 bits of entropy — unguessable enough to act as a capability token
 * while remaining short enough to type from a printed certificate.
 */
export function generateVerificationCode(): string {
  return randomCode(10);
}
