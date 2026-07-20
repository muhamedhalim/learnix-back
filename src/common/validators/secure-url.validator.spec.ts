import { validateSync } from 'class-validator';

import { IsSecureUrl } from './secure-url.validator';

class UrlInput {
  @IsSecureUrl()
  public value!: string;
}

function isValid(value: string): boolean {
  const input = new UrlInput();
  input.value = value;
  return validateSync(input).length === 0;
}

describe('IsSecureUrl', () => {
  it('accepts public HTTP(S) URLs', () => {
    expect(isValid('https://media.example.test/path')).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'https://localhost/path',
    'https://127.99.1.2/path',
    'https://10.0.0.1/path',
    'https://172.31.4.5/path',
    'https://192.168.1.2/path',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/path',
    'https://metadata.google.internal/path',
    'https://backend/path',
    'https://user:password@example.test/path',
  ])('rejects private, internal, credential-bearing or non-HTTP target %s', (value) => {
    expect(isValid(value)).toBe(false);
  });
});
