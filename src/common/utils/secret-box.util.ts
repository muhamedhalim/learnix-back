import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { ValueTransformer } from 'typeorm';

/**
 * AES-256-GCM encryption for OAuth refresh/access tokens at rest
 * (`teacher_meeting_accounts`). No encryption-at-rest primitive existed
 * before this — `node:crypto` was previously used only for hashing, random
 * IDs and HMAC — because a refresh token grants calendar/meeting access to a
 * real person's account and must never be recoverable from a database dump.
 *
 * Format: `v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>`. A random IV is
 * generated per call so identical plaintexts never produce identical
 * ciphertexts; the GCM auth tag detects any tampering with the stored value.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const FORMAT_VERSION = 'v1';

export class SecretBoxKeyError extends Error {}

/**
 * Decodes and validates a base64-encoded AES-256 key. Throws with a message
 * precise enough to fix at deploy time rather than surfacing as a downstream
 * decrypt failure.
 */
export function decodeSecretBoxKey(keyBase64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(keyBase64, 'base64');
  } catch {
    throw new SecretBoxKeyError('MEETING_TOKEN_ENCRYPTION_KEY must be valid base64.');
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new SecretBoxKeyError(
      `MEETING_TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES.toString()} bytes (got ${key.length.toString()}).`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = decodeSecretBoxKey(keyBase64);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const key = decodeSecretBoxKey(keyBase64);
  const parts = payload.split(':');
  const [version, ivB64, tagB64, cipherB64] = parts;
  if (parts.length !== 4 || version !== FORMAT_VERSION || !ivB64 || !tagB64 || cipherB64 === undefined) {
    throw new SecretBoxKeyError('Encrypted value is not in the expected v1 secret-box format.');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(cipherB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Reads the encryption key directly from `process.env` rather than through
 * `ConfigService`: TypeORM column transformers are instantiated at entity
 * decoration time, before Nest's DI container exists, so this is the only
 * timing that works. `env.validation.ts` still validates the same variable at
 * boot so a misconfigured deployment fails fast instead of on first read.
 */
export function resolveMeetingEncryptionKey(): string {
  const key = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
  if (!key) {
    throw new SecretBoxKeyError(
      'MEETING_TOKEN_ENCRYPTION_KEY is not configured — meeting provider accounts cannot be stored.',
    );
  }
  return key;
}

/**
 * TypeORM transformer for `access_token_encrypted` / `refresh_token_encrypted`.
 * Encrypts on write, decrypts on read; `null` passes through untouched so an
 * account with no refresh token (provider didn't issue one) round-trips cleanly.
 */
export const encryptedTextTransformer: ValueTransformer = {
  to: (value?: string | null): string | null => {
    if (value === null || value === undefined) return null;
    return encryptSecret(value, resolveMeetingEncryptionKey());
  },
  from: (value?: string | null): string | null => {
    if (value === null || value === undefined) return null;
    return decryptSecret(value, resolveMeetingEncryptionKey());
  },
};
