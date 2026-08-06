import type { EnvReader } from './redis-connection.util';
import {
  bullMqPrefix,
  namespacedKey,
  namespacedPrefix,
  resolveRedisNamespace,
} from './redis-namespace.util';

function readerFrom(values: Record<string, string | undefined>): EnvReader {
  return (key) => values[key];
}

describe('resolveRedisNamespace', () => {
  it('defaults to empty for a resolved production environment (byte-identical to today)', () => {
    expect(resolveRedisNamespace(readerFrom({ NODE_ENV: 'production' }))).toBe('');
  });

  it('defaults to empty for development (unchanged local workflow)', () => {
    expect(resolveRedisNamespace(readerFrom({}))).toBe('');
  });

  it('defaults to "learnix:staging" when APP_ENV=staging and no explicit namespace is set', () => {
    expect(resolveRedisNamespace(readerFrom({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe(
      'learnix:staging',
    );
  });

  it('defaults to "learnix:test" for NODE_ENV=test', () => {
    expect(resolveRedisNamespace(readerFrom({ NODE_ENV: 'test' }))).toBe('learnix:test');
  });

  it('an explicit REDIS_NAMESPACE always wins, even on production', () => {
    expect(
      resolveRedisNamespace(
        readerFrom({ NODE_ENV: 'production', REDIS_NAMESPACE: 'learnix:prod' }),
      ),
    ).toBe('learnix:prod');
  });

  it('an explicit REDIS_NAMESPACE overrides the staging default', () => {
    expect(
      resolveRedisNamespace(
        readerFrom({ APP_ENV: 'staging', REDIS_NAMESPACE: 'custom-staging-ns' }),
      ),
    ).toBe('custom-staging-ns');
  });

  it('trims whitespace on an explicit namespace', () => {
    expect(resolveRedisNamespace(readerFrom({ REDIS_NAMESPACE: '  learnix:staging  ' }))).toBe(
      'learnix:staging',
    );
  });

  it('treats a blank REDIS_NAMESPACE as unset, not as an explicit empty override', () => {
    expect(resolveRedisNamespace(readerFrom({ APP_ENV: 'staging', REDIS_NAMESPACE: '   ' }))).toBe(
      'learnix:staging',
    );
  });

  it('never throws on an unsupported APP_ENV — degrades to empty', () => {
    expect(resolveRedisNamespace(readerFrom({ APP_ENV: 'not-a-real-env' }))).toBe('');
  });
});

describe('namespacedPrefix', () => {
  it('is empty when there is no namespace', () => {
    expect(namespacedPrefix(readerFrom({ NODE_ENV: 'production' }))).toBe('');
  });

  it('has a trailing colon when a namespace is resolved', () => {
    expect(namespacedPrefix(readerFrom({ APP_ENV: 'staging' }))).toBe('learnix:staging:');
  });
});

describe('namespacedKey', () => {
  it('returns the key unchanged for production (no namespace)', () => {
    expect(namespacedKey(readerFrom({ NODE_ENV: 'production' }), 'idempotency:webhook:1')).toBe(
      'idempotency:webhook:1',
    );
  });

  it('prefixes the key for staging', () => {
    expect(namespacedKey(readerFrom({ APP_ENV: 'staging' }), 'idempotency:webhook:1')).toBe(
      'learnix:staging:idempotency:webhook:1',
    );
  });
});

describe('bullMqPrefix', () => {
  it('is undefined for production so BullMQ keeps its own default prefix', () => {
    expect(bullMqPrefix(readerFrom({ NODE_ENV: 'production' }))).toBeUndefined();
  });

  it('is the bare namespace (no trailing colon) for staging — BullMQ adds its own separators', () => {
    expect(bullMqPrefix(readerFrom({ APP_ENV: 'staging' }))).toBe('learnix:staging');
  });
});
