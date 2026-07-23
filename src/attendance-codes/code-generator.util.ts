import { createHash, randomBytes } from 'node:crypto';

// Excludes visually ambiguous characters (0/O, 1/I) for reliable manual entry.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Generate a cryptographically-random 8-character attendance code. Uniqueness
 * is enforced at the database layer (unique index); callers generating in bulk
 * should insert with ON CONFLICT DO NOTHING and top up any shortfall.
 */
export function generateAttendanceCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  }
  return code;
}

export function normalizeAttendanceCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, '');
}

/**
 * Deterministic lookup digest. The raw code remains encrypted/private-export
 * inventory for backward compatibility, while public/student lookup uses this
 * indexed digest and never writes the raw code to logs.
 */
export function hashAttendanceCode(value: string): string {
  return createHash('sha256').update(normalizeAttendanceCode(value), 'utf8').digest('hex');
}
