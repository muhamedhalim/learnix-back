import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddThumbnailToLesson1768609000000 implements MigrationInterface {
  public name = 'AddThumbnailToLesson1768609000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "thumbnail" varchar(500);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "thumbnail";
    `);
  }
}
