import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Keeps display filenames separate from private R2 object references. */
export class AddHomeworkPrivateFileNames2020000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "lesson_homework" ADD COLUMN IF NOT EXISTS "resource_filename" varchar(255)`,
    );
    await q.query(
      `ALTER TABLE "homework_submissions" ADD COLUMN IF NOT EXISTS "resource_filename" varchar(255)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "homework_submissions" DROP COLUMN IF EXISTS "resource_filename"`);
    await q.query(`ALTER TABLE "lesson_homework" DROP COLUMN IF EXISTS "resource_filename"`);
  }
}
