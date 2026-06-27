import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfilePictureThumbnail1768620000000 implements MigrationInterface {
  public name = 'AddProfilePictureThumbnail1768620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add profile_picture_thumbnail_url column to users table
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "profile_picture_thumbnail_url" varchar
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove column
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "profile_picture_thumbnail_url"
    `);
  }
}
