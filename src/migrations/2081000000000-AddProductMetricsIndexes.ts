import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the DEF-007 metrics layer.
 *
 * The Stats/Counts endpoints used to return placeholders and hardcoded zeros,
 * so none of these access paths had ever been exercised. Now that every one of
 * them runs a real aggregate — including a correlated per-lesson student count
 * that also serves as a sort key on a paginated list — each one needs an index
 * that lets Postgres answer it from the index alone instead of scanning.
 *
 * All partial, matching the exact predicates in
 * `ProductFinancialMetricsService` / `LearningMetricsService`, so they stay
 * small. Created CONCURRENTLY (hence `transaction = false`) so applying this to
 * a live database does not take a write lock on the finance tables.
 */
export class AddProductMetricsIndexes2081000000000 implements MigrationInterface {
  public name = 'AddProductMetricsIndexes2081000000000';

  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-lesson unique student count: the projection, the `sortBy=students_count`
    // ordering, and the batch map all reduce to this (lesson_id, student_id)
    // lookup over live access rows.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_purchases_lesson_student_live"
      ON "lesson_purchases" ("lesson_id", "student_id")
      WHERE "revoked_at" IS NULL
    `);

    // Per-teacher "students with access" rollup walks the same table by student.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_purchases_student_live"
      ON "lesson_purchases" ("student_id", "lesson_id")
      WHERE "revoked_at" IS NULL
    `);

    // Course access counts, and the distinct-version rollup on top of them.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_package_purchases_package_student_live"
      ON "package_purchases" ("package_id", "student_id")
      WHERE "revoked_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_package_purchases_student_live"
      ON "package_purchases" ("student_id", "package_id")
      WHERE "revoked_at" IS NULL
    `);

    // Completed-lesson counts, per lesson and per student.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_progress_completed_lesson"
      ON "lesson_progress" ("lesson_id", "student_id")
      WHERE "completed" = true
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_progress_completed_student"
      ON "lesson_progress" ("student_id", "lesson_id")
      WHERE "completed" = true
    `);

    // Settled-order aggregates. `IDX_orders_item` already covers
    // (item_type, item_id) but includes every abandoned checkout; restricting
    // to the paid terminal states keeps this index proportional to real sales.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_orders_settled_item"
      ON "orders" ("item_type", "item_id")
      WHERE "status" IN ('paid', 'partially_refunded', 'refunded')
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_orders_settled_teacher"
      ON "orders" ("teacher_id")
      WHERE "status" IN ('paid', 'partially_refunded', 'refunded')
    `);

    // Graded-attempt count and average score for one student.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_exam_attempts_student_graded"
      ON "exam_attempts" ("student_id")
      WHERE "state" = 'graded'
    `);

    // Teacher rating aggregate, single and batched.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_teacher_reviews_teacher_approved"
      ON "teacher_reviews" ("teacher_id", "rating")
      WHERE "status" = 'approved'
    `);

    // Lesson and course rating aggregates (the latter joins through
    // lesson_package_items, so it lands on lesson_id).
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_reviews_lesson_approved"
      ON "lesson_reviews" ("lesson_id", "rating")
      WHERE "status" = 'approved'
    `);

    // Subject teacher counts join teacher_subjects → teacher_profiles → users.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_teacher_profiles_user_live"
      ON "teacher_profiles" ("user_id", "id")
      WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [
      'IDX_teacher_profiles_user_live',
      'IDX_lesson_reviews_lesson_approved',
      'IDX_teacher_reviews_teacher_approved',
      'IDX_exam_attempts_student_graded',
      'IDX_orders_settled_teacher',
      'IDX_orders_settled_item',
      'IDX_lesson_progress_completed_student',
      'IDX_lesson_progress_completed_lesson',
      'IDX_package_purchases_student_live',
      'IDX_package_purchases_package_student_live',
      'IDX_lesson_purchases_student_live',
      'IDX_lesson_purchases_lesson_student_live',
    ]) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
    }
  }
}
