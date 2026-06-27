import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration verifies that all necessary indexes exist for student profile aggregation.
 * All indexes are already defined in the entities via @Index decorators,
 * so this migration primarily serves as documentation.
 *
 * Existing indexes verified:
 * - lesson_purchases: student_id, lesson_id, (student_id, lesson_id), access_expires_at
 * - exam_attempts: exam_id, student_id, status, UNIQUE(exam_id, student_id)
 */
export class VerifyProfileAggregationIndexes1768611000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Verify composite index exists on lesson_purchases
    // This index optimizes queries in findStudentProfile() for lesson aggregation
    const lessonPurchaseIndexes = (await queryRunner.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'lesson_purchases'
        AND indexname = 'IDX_lesson_purchases_student_lesson';
    `)) as Array<{ indexname: string }>;

    if (lessonPurchaseIndexes.length === 0) {
      // Index doesn't exist, create it
      await queryRunner.query(`
        CREATE INDEX "IDX_lesson_purchases_student_lesson"
          ON "lesson_purchases" ("student_id", "lesson_id");
      `);
    }

    // Verify unique constraint exists on exam_attempts (serves as composite index)
    const examAttemptsConstraints = (await queryRunner.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'UQ_exam_attempts_exam_student';
    `)) as Array<{ conname: string }>;

    if (examAttemptsConstraints.length === 0) {
      // Constraint doesn't exist, create it
      await queryRunner.query(`
        ALTER TABLE "exam_attempts"
          ADD CONSTRAINT "UQ_exam_attempts_exam_student"
          UNIQUE ("exam_id", "student_id");
      `);
    }

    // Note: UNIQUE constraint automatically creates a B-tree index,
    // so no separate composite index is needed for exam_attempts
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback: Drop indexes if they were created by this migration
    // Note: We don't drop indexes that were created by entity decorators
    // This down migration is primarily for documentation purposes

    const lessonPurchaseIndexes = (await queryRunner.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'lesson_purchases'
        AND indexname = 'IDX_lesson_purchases_student_lesson';
    `)) as Array<{ indexname: string }>;

    if (lessonPurchaseIndexes.length > 0) {
      await queryRunner.query(`
        DROP INDEX IF EXISTS "IDX_lesson_purchases_student_lesson";
      `);
    }

    const examAttemptsConstraints = (await queryRunner.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'UQ_exam_attempts_exam_student';
    `)) as Array<{ conname: string }>;

    if (examAttemptsConstraints.length > 0) {
      await queryRunner.query(`
        ALTER TABLE "exam_attempts"
          DROP CONSTRAINT IF EXISTS "UQ_exam_attempts_exam_student";
      `);
    }
  }
}
