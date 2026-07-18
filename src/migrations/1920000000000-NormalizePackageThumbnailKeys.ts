import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts legacy local media URLs in package covers into provider-neutral
 * object keys. The media layer can then render the active deployment's HTTPS
 * public origin instead of preserving the old machine's localhost host name.
 */
export class NormalizePackageThumbnailKeys1920000000000 implements MigrationInterface {
  public readonly name = 'NormalizePackageThumbnailKeys1920000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "lesson_packages"
      SET "thumbnail" = regexp_replace(
        "thumbnail",
        '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?/(?:api/v1/)?(?:media/public|uploads)/((?:images|thumbnails|profiles|resources|attachments)/[^/?#]+)(?:[?#].*)?$',
        '\\1'
      )
      WHERE "thumbnail" ~
        '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?/(?:api/v1/)?(?:media/public|uploads)/((?:images|thumbnails|profiles|resources|attachments)/[^/?#]+)(?:[?#].*)?$'
    `);

    await queryRunner.query(`
      UPDATE "lesson_packages"
      SET "thumbnail" = regexp_replace(
        "thumbnail",
        '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?/(?:uploads/)?((?:images|thumbnails|profiles|resources|attachments)/[^/?#]+)(?:[?#].*)?$',
        '\\1'
      )
      WHERE "thumbnail" ~
        '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?/(?:uploads/)?((?:images|thumbnails|profiles|resources|attachments)/[^/?#]+)(?:[?#].*)?$'
    `);
  }

  public async down(): Promise<void> {
    // Intentionally irreversible: the previous localhost origin is not a
    // meaningful deployment value and reconstructing it would reintroduce the
    // production defect. A code rollback remains safe because it accepts keys.
  }
}
