import { randomBytes } from 'node:crypto';

import {
  decodeSecretBoxKey,
  decryptSecret,
  encryptSecret,
  encryptedTextTransformer,
  resolveMeetingEncryptionKey,
  SecretBoxKeyError,
} from './secret-box.util';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('secret-box.util', () => {
  it('round-trips a plaintext value', () => {
    const encrypted = encryptSecret('refresh-token-value', KEY);
    expect(decryptSecret(encrypted, KEY)).toBe('refresh-token-value');
  });

  it('produces a different ciphertext for the same plaintext on each call (random IV)', () => {
    const first = encryptSecret('same-value', KEY);
    const second = encryptSecret('same-value', KEY);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, KEY)).toBe('same-value');
    expect(decryptSecret(second, KEY)).toBe('same-value');
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const encrypted = encryptSecret('secret-value', KEY);
    const parts = encrypted.split(':');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64');
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0xff, 0);
    const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64')].join(':');

    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('secret-value', KEY);
    expect(() => decryptSecret(encrypted, OTHER_KEY)).toThrow();
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    expect(() => encryptSecret('value', Buffer.from('too-short').toString('base64'))).toThrow(
      SecretBoxKeyError,
    );
  });

  describe('resolveMeetingEncryptionKey', () => {
    const original = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
    afterEach(() => {
      process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = original;
    });

    it('throws a clear error when unset', () => {
      delete process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
      expect(() => resolveMeetingEncryptionKey()).toThrow(SecretBoxKeyError);
    });

    it('returns the configured key', () => {
      process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = KEY;
      expect(resolveMeetingEncryptionKey()).toBe(KEY);
    });
  });

  describe('encryptedTextTransformer', () => {
    const original = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
    beforeEach(() => {
      process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = KEY;
    });
    afterEach(() => {
      process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = original;
    });

    it('round-trips through to/from', () => {
      const stored = encryptedTextTransformer.to('a-refresh-token');
      expect(stored).not.toBe('a-refresh-token');
      expect(encryptedTextTransformer.from(stored)).toBe('a-refresh-token');
    });

    it('passes null through untouched on both sides', () => {
      expect(encryptedTextTransformer.to(null)).toBeNull();
      expect(encryptedTextTransformer.from(null)).toBeNull();
    });
  });
});

describe('decodeSecretBoxKey base64 validation', () => {
  it('rejects characters outside the base64 alphabet instead of silently skipping them', () => {
    expect(() => decodeSecretBoxKey('not base64 !!')).toThrow(/valid base64/);
  });

  it('accepts a valid 32-byte key', () => {
    expect(decodeSecretBoxKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
  });
});
