import 'reflect-metadata';

import { validateAwsRuntimeProfile } from './env.validation';

const aws = { APP_ENV: 'production', S3_BUCKET: 'learnix-production-files' };

describe('validateAwsRuntimeProfile', () => {
  it('does nothing outside the AWS profile (no S3 bucket, or another environment)', () => {
    expect(() => validateAwsRuntimeProfile({ MAIL_PROVIDER: 'typo' })).not.toThrow();
    expect(() =>
      validateAwsRuntimeProfile({ APP_ENV: 'development', S3_BUCKET: 'b', MAIL_PROVIDER: 'typo' }),
    ).not.toThrow();
  });

  it('accepts the values the AWS tasks set', () => {
    expect(() =>
      validateAwsRuntimeProfile({
        ...aws,
        MAIL_PROVIDER: 'ses',
        SMS_PROVIDER: 'aws',
        PUSH_PROVIDER: 'webpush',
        MEDIA_EVENTS_QUEUE_URL:
          'https://sqs.eu-central-1.amazonaws.com/123456789012/learnix-production-media-events',
      }),
    ).not.toThrow();
  });

  it.each([
    ['MAIL_PROVIDER', 'sess'],
    ['SMS_PROVIDER', 'amazon'],
    ['PUSH_PROVIDER', 'webpsuh'],
  ])('rejects %s=%s instead of silently disabling the feature', (key, value) => {
    expect(() => validateAwsRuntimeProfile({ ...aws, [key]: value })).toThrow(new RegExp(key));
  });

  it('rejects a malformed SQS queue URL', () => {
    expect(() =>
      validateAwsRuntimeProfile({ ...aws, MAIL_EVENTS_QUEUE_URL: 'http://localhost:4566/queue' }),
    ).toThrow(/MAIL_EVENTS_QUEUE_URL/);
  });

  it('refuses a legacy storage provider in production unless explicitly allowed', () => {
    expect(() => validateAwsRuntimeProfile({ ...aws, R2_BUCKET: 'old' })).toThrow(/R2_BUCKET/);
    expect(() =>
      validateAwsRuntimeProfile({ ...aws, R2_BUCKET: 'old', LEGACY_PROVIDERS_ALLOWED: 'true' }),
    ).not.toThrow();
    expect(() =>
      validateAwsRuntimeProfile({ APP_ENV: 'staging', S3_BUCKET: 'b', R2_BUCKET: 'old' }),
    ).not.toThrow();
  });
});
