import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces known legacy localhost public-media URLs with provider-neutral
 * object keys. The media response layer then builds the active deployment's
 * configured HTTPS origin at read time.
 *
 * Private resources and unrecognised external URLs are deliberately untouched.
 */
export class NormalizeLegacyPublicMediaReferences2000000000000 implements MigrationInterface {
  private readonly targets = [
    ['lessons', 'thumbnail'],
    ['lesson_packages', 'thumbnail'],
    ['books', 'cover_image'],
    ['subjects', 'thumbnail'],
    ['users', 'profile_picture_url'],
    ['users', 'profile_picture_thumbnail_url'],
  ] as const;

  private readonly legacyPublicMediaPattern =
    '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?/(?:api/v1/)?(?:media/public|uploads)/((?:images|thumbnails|profiles)/[^/?#]+)(?:[?#].*)?$';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of this.targets) {
      await queryRunner.query(
        `
          UPDATE "${table}"
          SET "${column}" = regexp_replace("${column}", $1, '\\1')
          WHERE "${column}" ~ $1
        `,
        [this.legacyPublicMediaPattern],
      );
    }
  }

  public async down(): Promise<void> {
    // Irreversible by design: a localhost origin is not meaningful deployment data.
  }
}
