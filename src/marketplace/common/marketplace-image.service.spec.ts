import {
  MarketplaceImageService,
  assertMarketplaceImageKey,
  isMarketplaceImageKey,
  marketplaceImagePrefix,
} from './marketplace-image.service';
import { MarketplaceStorageService } from './marketplace-storage.service';

const USER = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const KEY = `images/marketplace/${USER}/${FILE}.jpg`;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildService() {
  const storage = { uploadPublicImage: jest.fn().mockResolvedValue(undefined) };
  const service = new MarketplaceImageService(storage as unknown as MarketplaceStorageService);
  return { service, storage };
}

const file = (
  over: Partial<{ originalname: string; mimetype: string; size: number; buffer: Buffer }> = {},
) => ({
  originalname: 'cover.jpg',
  mimetype: 'image/jpeg',
  size: 1000,
  buffer: JPEG,
  ...over,
});

describe('marketplace image keys', () => {
  it('recognises only the exact shape the upload route issues', () => {
    expect(isMarketplaceImageKey(KEY)).toBe(true);
    expect(isMarketplaceImageKey(`images/marketplace/${USER}/${FILE}.png`)).toBe(true);
    expect(isMarketplaceImageKey(`images/marketplace/${USER}/${FILE}.webp`)).toBe(true);
    for (const bad of [
      'https://cdn.example.com/photos/nour.jpg',
      '//evil.example/x.jpg',
      'covers/1.jpg',
      `images/${USER}/${FILE}.jpg`,
      `images/marketplace/${USER}/${FILE}.gif`,
      `images/marketplace/${USER}/${FILE}.jpg?x=1`,
      `images/marketplace/${USER}/../${FILE}.jpg`,
      `images/marketplace/${USER}/${FILE}.jpg/extra`,
      `images/marketplace/not-a-uuid/${FILE}.jpg`,
      '',
    ]) {
      expect(isMarketplaceImageKey(bad)).toBe(false);
    }
  });

  it('allows empty values, an unchanged stored value and an uploaded key, and refuses everything else', () => {
    expect(() => assertMarketplaceImageKey(undefined)).not.toThrow();
    expect(() => assertMarketplaceImageKey(null)).not.toThrow();
    expect(() => assertMarketplaceImageKey('')).not.toThrow();
    expect(() => assertMarketplaceImageKey(KEY)).not.toThrow();
    expect(() => assertMarketplaceImageKey('covers/legacy.jpg', 'covers/legacy.jpg')).not.toThrow();
    expect(() =>
      assertMarketplaceImageKey('https://tracker.example/p.gif', 'covers/legacy.jpg'),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'INVALID_IMAGE_REFERENCE' }),
      }),
    );
    expect(() => assertMarketplaceImageKey('covers/legacy.jpg')).toThrow();
  });
});

describe('MarketplaceImageService.upload', () => {
  it("stores a valid image in the uploader's own folder and returns a key, never a URL", async () => {
    const { service, storage } = buildService();
    const { key } = await service.upload(USER, file());
    expect(key.startsWith(marketplaceImagePrefix(USER))).toBe(true);
    expect(isMarketplaceImageKey(key)).toBe(true);
    expect(storage.uploadPublicImage).toHaveBeenCalledWith({
      buffer: JPEG,
      path: key,
      contentType: 'image/jpeg',
    });
  });

  it('derives the extension from the verified type, not from the file name', async () => {
    const { service } = buildService();
    const { key } = await service.upload(
      USER,
      file({ originalname: 'photo.png', mimetype: 'image/png', buffer: PNG }),
    );
    expect(key.endsWith('.png')).toBe(true);
  });

  it('gives each upload its own key', async () => {
    const { service } = buildService();
    const a = await service.upload(USER, file());
    const b = await service.upload(USER, file());
    expect(a.key).not.toBe(b.key);
  });

  it.each([
    ['no file', undefined],
    ['a type that is not allowed (gif)', file({ mimetype: 'image/gif', originalname: 'a.gif' })],
    ['a PDF', file({ mimetype: 'application/pdf', originalname: 'a.pdf' })],
    ['an extension that does not match the type', file({ originalname: 'cover.png' })],
    [
      'content that is not the declared type',
      file({ buffer: Buffer.from('<script>alert(1)</script>') }),
    ],
    ['a path in the file name', file({ originalname: '../cover.jpg' })],
    ['a file over 5 MB', file({ size: 5 * 1024 * 1024 + 1 })],
  ])('refuses %s and stores nothing', async (_label, input) => {
    const { service, storage } = buildService();
    await expect(service.upload(USER, input)).rejects.toMatchObject({ status: 400 });
    expect(storage.uploadPublicImage).not.toHaveBeenCalled();
  });
});

describe('MarketplaceStorageService.uploadPublicImage', () => {
  function buildStorage() {
    const raw = { upload: jest.fn().mockResolvedValue({ path: 'k' }) };
    return { storage: new MarketplaceStorageService(raw as never), raw };
  }

  it('publishes only inside images/marketplace/', async () => {
    const { storage, raw } = buildStorage();
    await storage.uploadPublicImage({ buffer: JPEG, path: KEY, contentType: 'image/jpeg' });
    expect(raw.upload).toHaveBeenCalledWith(
      expect.objectContaining({ path: KEY, visibility: 'public' }),
    );
  });

  it.each([
    'lessons/video.mp4',
    'marketplace/applications/a/documents/d',
    'images/teacher/x.jpg',
    'images/marketplace/../books/x.pdf',
  ])('refuses %s, so nothing else can be published through it', async (path) => {
    const { storage, raw } = buildStorage();
    await expect(
      storage.uploadPublicImage({ buffer: JPEG, path, contentType: 'image/jpeg' }),
    ).rejects.toThrow();
    expect(raw.upload).not.toHaveBeenCalled();
  });

  it('keeps every other marketplace upload private', async () => {
    const { storage, raw } = buildStorage();
    await storage.uploadPrivate({
      buffer: JPEG,
      path: 'marketplace/applications/a/documents/d',
      contentType: 'application/pdf',
    });
    expect(raw.upload).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }));
  });
});
