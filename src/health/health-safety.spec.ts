import { sanitiseMessage, sanitiseMetadata } from './health-sanitizer.util';
import { HealthCheckTimeoutError, withHealthTimeout } from './health-timeout.util';

describe('health safety boundaries', () => {
  it('times out unavailable providers without waiting indefinitely', async () => {
    await expect(
      withHealthTimeout('provider', new Promise(() => undefined), 5),
    ).rejects.toBeInstanceOf(HealthCheckTimeoutError);
  });

  it('redacts secrets and private connection URLs recursively', () => {
    const output = sanitiseMetadata({
      apiKey: 'super-secret',
      nested: {
        password: 'password',
        message: 'failed at postgres://user:pass@private/db',
        privateEndpoint: 'http://10.0.0.8:9000/internal/path',
      },
    });
    expect(JSON.stringify(output)).not.toContain('super-secret');
    expect(JSON.stringify(output)).not.toContain('user:pass');
    expect(output).toEqual({
      apiKey: '[redacted]',
      nested: {
        password: '[redacted]',
        message: 'failed at [private-url]',
        privateEndpoint: '[private-url]',
      },
    });
  });

  it('removes bearer tokens, JWTs, and full email addresses from messages', () => {
    const output = sanitiseMessage('Bearer abc.def.ghi eyJabc.def.ghi admin@example.com');
    expect(output).not.toContain('abc.def.ghi');
    expect(output).not.toContain('admin@example.com');
  });
});
