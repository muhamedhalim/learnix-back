import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLessonProgressTable1768625000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create lesson_progress table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lesson_progress" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "student_id" UUID NOT NULL,
        "lesson_id" UUID NOT NULL,
        "watched_duration" INT NOT NULL DEFAULT 0,
        "total_duration" INT NOT NULL,
        "progress_percent" INT NOT NULL DEFAULT 0,
        "completed" BOOLEAN NOT NULL DEFAULT FALSE,
        "last_watched_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "FK_lesson_progress_student" FOREIGN KEY ("student_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lesson_progress_lesson" FOREIGN KEY ("lesson_id")
          REFERENCES "lessons"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_lesson_progress_student_lesson" UNIQUE ("student_id", "lesson_id")
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_progress_student_id"
      ON "lesson_progress" ("student_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_progress_completed"
      ON "lesson_progress" ("completed")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lesson_progress_completed"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lesson_progress_student_id"`,
    );

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS "lesson_progress"`);
  }
}
