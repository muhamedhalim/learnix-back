import { StorageService } from './storage.service';

function config(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as never;
}

describe('StorageService legacy media URL normalization', () => {
  it('recognizes and converts a persisted localhost media URL into a key', () => {
    const storage = new StorageService(
      config({
        NODE_ENV: 'development',
        R2_ACCOUNT_ID: 'account',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_BUCKET: 'bucket',
        R2_PUBLIC_BASE_URL: 'https://media.learnix.example',
      }),
    );
    const legacy = 'http://localhost:3001/api/v1/media/public/images/cover.jpg';

    expect(storage.isOwnUrl(legacy)).toBe(true);
    expect(storage.toKey(legacy)).toBe('images/cover.jpg');
  });

  it('does not allow the local-disk provider in production', () => {
    expect(() => new StorageService(config({ NODE_ENV: 'production' }))).toThrow(
      'R2 or Bunny object storage must be configured in production',
    );
  });

  it('rejects a localhost R2 public origin in production', () => {
    expect(
      () =>
        new StorageService(
          config({
            NODE_ENV: 'production',
            R2_ACCOUNT_ID: 'account',
            R2_ACCESS_KEY_ID: 'key',
            R2_SECRET_ACCESS_KEY: 'secret',
            R2_BUCKET: 'bucket',
            R2_PUBLIC_BASE_URL: 'http://localhost:3001',
          }),
        ),
    ).toThrow('R2_PUBLIC_BASE_URL must be a public HTTPS origin in production');
  });
});
