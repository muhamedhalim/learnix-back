import { NormalizePackageThumbnailKeys1920000000000 } from './1920000000000-NormalizePackageThumbnailKeys';

describe('NormalizePackageThumbnailKeys1920000000000', () => {
  it('backfills only recognized localhost public-media paths to object keys', async () => {
    const query = jest.fn();
    const migration = new NormalizePackageThumbnailKeys1920000000000();

    await migration.up({ query } as never);

    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('UPDATE "lesson_packages"');
    expect(sql).toContain('localhost');
    expect(sql).toContain('media/public');
    expect(sql).toContain('uploads');
    expect(sql).toContain('images|thumbnails|profiles|resources|attachments');
    expect(sql).toContain("'\\1'");
  });

  it('has no destructive reverse migration that could recreate localhost URLs', async () => {
    await expect(
      new NormalizePackageThumbnailKeys1920000000000().down({} as never),
    ).resolves.toBeUndefined();
  });
});
