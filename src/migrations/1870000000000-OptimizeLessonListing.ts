import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OptimizeLessonListing1870000000000 implements MigrationInterface {
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lessons_active_created_id"
      ON "lessons" ("created_at", "id")
      WHERE "deleted_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lessons_teacher_active_created_id"
      ON "lessons" ("teacher_id", "created_at", "id")
      WHERE "deleted_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lessons_subject_active_created_id"
      ON "lessons" ("subject_id", "created_at", "id")
      WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_lessons_subject_active_created_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_lessons_teacher_active_created_id"`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_lessons_active_created_id"`);
  }
}
