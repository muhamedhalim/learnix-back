import { MarketplaceStorageService } from './marketplace-storage.service';
import type { StorageService } from '../../storage/storage.service';

function buildStorage(): jest.Mocked<StorageService> {
  return {
    upload: jest.fn(async (params: { path: string; visibility?: string }) => ({
      url: '',
      path: params.path,
      size: 100,
      visibility: params.visibility,
    })),
    getSignedUrl: jest.fn(async (path: string, expiresInSeconds?: number) => `https://signed/${path}?ttl=${expiresInSeconds}`),
  } as unknown as jest.Mocked<StorageService>;
}

describe('MarketplaceStorageService', () => {
  describe('uploadPrivate', () => {
    it('always uploads with visibility private, regardless of caller intent', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await service.uploadPrivate({ buffer: Buffer.from('x'), path: 'k', contentType: 'application/pdf' });

      expect(storage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'k', contentType: 'application/pdf', visibility: 'private' }),
      );
    });
  });

  describe('getSignedUrl', () => {
    it('re-checks authorization before every issuance', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);
      const authorize = jest.fn().mockResolvedValue(true);

      await service.getSignedUrl('k', authorize);
      await service.getSignedUrl('k', authorize);

      expect(authorize).toHaveBeenCalledTimes(2);
    });

    it('refuses when the authorization check fails, without calling storage at all', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await expect(service.getSignedUrl('k', () => false)).rejects.toThrow();
      expect(storage.getSignedUrl).not.toHaveBeenCalled();
    });

    it('never exceeds the 900-second TTL ceiling even when a longer lifetime is requested', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await service.getSignedUrl('k', () => true, 3600);

      expect(storage.getSignedUrl).toHaveBeenCalledWith('k', 900);
    });

    it('defaults to the 900-second ceiling when no lifetime is requested', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await service.getSignedUrl('k', () => true);

      expect(storage.getSignedUrl).toHaveBeenCalledWith('k', 900);
    });

    it('honours a shorter requested lifetime', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await service.getSignedUrl('k', () => true, 60);

      expect(storage.getSignedUrl).toHaveBeenCalledWith('k', 60);
    });

    it('supports an async authorization check', async () => {
      const storage = buildStorage();
      const service = new MarketplaceStorageService(storage);

      await expect(
        service.getSignedUrl('k', async () => {
          await Promise.resolve();
          return true;
        }),
      ).resolves.toContain('https://signed/k');
    });
  });
});
