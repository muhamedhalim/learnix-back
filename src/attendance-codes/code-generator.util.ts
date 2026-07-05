import { randomBytes } from 'node:crypto';

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
