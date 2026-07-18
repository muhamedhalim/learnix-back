import { BadRequestException } from '@nestjs/common';

import { MediaService } from './media.service';

function config(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as never;
}

describe('MediaService public URL policy', () => {
  it('uses the configured HTTPS public media origin for a stored object key', () => {
    const storage = {
      isOwnUrl: jest.fn().mockReturnValue(true),
      toKey: jest.fn().mockReturnValue('images/cover.jpg'),
    } as never;
    const service = new MediaService(
      storage,
      config({ NODE_ENV: 'production', PUBLIC_MEDIA_BASE_URL: 'https://api.learnix.example' }),
    );

    expect(service.resolveThumbnailUrl('images/cover.jpg')).toBe(
      'https://api.learnix.example/api/v1/media/public/images/cover.jpg',
    );
  });

  it('normalizes a legacy localhost media URL to its object key before persistence', () => {
    const storage = {
      isOwnUrl: jest.fn().mockReturnValue(true),
      toKey: jest.fn().mockReturnValue('images/cover.jpg'),
    } as never;
    const service = new MediaService(
      storage,
      config({ NODE_ENV: 'production', PUBLIC_MEDIA_BASE_URL: 'https://api.learnix.example' }),
    );

    expect(
      service.normalizeStoredPublicReference(
        'http://localhost:3001/api/v1/media/public/images/cover.jpg',
      ),
    ).toBe('images/cover.jpg');
  });

  it('rejects a new localhost value that is not a recognized storage URL', () => {
    const storage = { isOwnUrl: jest.fn().mockReturnValue(false) } as never;
    const service = new MediaService(
      storage,
      config({ NODE_ENV: 'production', PUBLIC_MEDIA_BASE_URL: 'https://api.learnix.example' }),
    );

    expect(() =>
      service.normalizeStoredPublicReference('http://localhost:3001/not-media.jpg'),
    ).toThrow(BadRequestException);
  });

  it('fails startup rather than emitting localhost URLs in production', () => {
    expect(
      () =>
        new MediaService(
          {} as never,
          config({ NODE_ENV: 'production', PUBLIC_MEDIA_BASE_URL: 'http://localhost:3001' }),
        ),
    ).toThrow('PUBLIC_MEDIA_BASE_URL must be a non-localhost HTTPS URL in production');
  });
});
