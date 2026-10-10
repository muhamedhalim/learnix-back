import {
  buildLoggerOptions,
  resolveKeepAliveTimeouts,
  resolveLogFormat,
  resolveTrustProxyHops,
} from './http-runtime';

const reader = (env: Record<string, string | undefined>) => (key: string) => env[key];

describe('http runtime config', () => {
  describe('trust proxy hops', () => {
    it('defaults to 1', () => expect(resolveTrustProxyHops(reader({}))).toBe(1));
    it('accepts 2 for CloudFront + ALB', () =>
      expect(resolveTrustProxyHops(reader({ TRUST_PROXY_HOPS: '2' }))).toBe(2));
    it.each(['-1', '6', 'two', '1.5'])('rejects %s', (value) =>
      expect(() => resolveTrustProxyHops(reader({ TRUST_PROXY_HOPS: value }))).toThrow(
        /TRUST_PROXY_HOPS/,
      ),
    );
  });

  describe('keep-alive', () => {
    it('defaults above the ALB 120 s idle timeout, with headers above keep-alive', () => {
      const { keepAliveTimeoutMs, headersTimeoutMs } = resolveKeepAliveTimeouts(reader({}));
      expect(keepAliveTimeoutMs).toBe(125_000);
      expect(headersTimeoutMs).toBeGreaterThan(keepAliveTimeoutMs);
    });
    it('honours an override', () =>
      expect(
        resolveKeepAliveTimeouts(reader({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '61000' })).headersTimeoutMs,
      ).toBe(66_000));
    it('rejects nonsense', () =>
      expect(() => resolveKeepAliveTimeouts(reader({ HTTP_KEEP_ALIVE_TIMEOUT_MS: 'x' }))).toThrow());
  });

  describe('log format', () => {
    it('defaults to coloured text', () => {
      expect(resolveLogFormat(reader({}))).toBe('text');
      expect(buildLoggerOptions(['log'], reader({}))).toEqual({
        logLevels: ['log'],
        json: false,
        colors: true,
      });
    });
    it('json disables colours', () =>
      expect(buildLoggerOptions(['log'], reader({ LOG_FORMAT: 'json' }))).toMatchObject({
        json: true,
        colors: false,
      }));
    it('rejects unknown formats', () =>
      expect(() => resolveLogFormat(reader({ LOG_FORMAT: 'yaml' }))).toThrow(/LOG_FORMAT/));
  });
});
