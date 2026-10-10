import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDatabaseSsl } from './database-ssl.util';

const reader = (env: Record<string, string | undefined>) => (key: string) => env[key];

describe('resolveDatabaseSsl', () => {
  it('is off for loopback and for a missing/invalid URL', () => {
    expect(resolveDatabaseSsl('postgres://u:p@localhost:5432/db', reader({}))).toBe(false);
    expect(resolveDatabaseSsl('postgres://u:p@127.0.0.1/db', reader({}))).toBe(false);
    expect(resolveDatabaseSsl(undefined, reader({}))).toBe(false);
    expect(resolveDatabaseSsl('not a url', reader({}))).toBe(false);
  });

  it('verifies certificates for remote hosts by default', () => {
    expect(resolveDatabaseSsl('postgres://u:p@db.example.rds.amazonaws.com/db', reader({}))).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('allows an explicit opt-out of verification', () => {
    expect(
      resolveDatabaseSsl(
        'postgres://u:p@db.example.com/db',
        reader({ SSL_REJECT_UNAUTHORIZED: 'false' }),
      ),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('adds an inline CA, turning escaped newlines into real ones', () => {
    const ssl = resolveDatabaseSsl(
      'postgres://u:p@db.example.com/db',
      reader({ DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----' }),
    );
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect((ssl as { ca: string }).ca).toContain('\nABC\n');
  });

  it('reads a CA bundle from DATABASE_SSL_CA_FILE', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ca-')), 'bundle.pem');
    writeFileSync(file, 'PEM-CONTENT');
    const ssl = resolveDatabaseSsl(
      'postgres://u:p@db.example.com/db',
      reader({ DATABASE_SSL_CA_FILE: file }),
    );
    expect((ssl as { ca: string }).ca).toBe('PEM-CONTENT');
  });

  it('fails loudly when the configured CA file is unreadable', () => {
    expect(() =>
      resolveDatabaseSsl(
        'postgres://u:p@db.example.com/db',
        reader({ DATABASE_SSL_CA_FILE: join(tmpdir(), 'does-not-exist.pem') }),
      ),
    ).toThrow();
  });
});
