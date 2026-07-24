import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the practice-solve ledger one final answer per student/question.
 *
 * Historical duplicate rows were created by the old retry-friendly flow. Keep
 * the earliest final answer because it was the one that determined the
 * first-attempt scoring state, then rebuild the derived attempt totals.
 */
export class EnforceSinglePublicPracticeAttempt1960000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "question_solves" duplicate
      USING "question_solves" original
      WHERE duplicate."user_id" = original."user_id"
        AND duplicate."question_id" = original."question_id"
        AND (duplicate."created_at", duplicate."id") > (original."created_at", original."id")
    `);

    // The question state is a projection of the final-answer ledger. Rebuild
    // it rather than leave old times_seen/times_correct values in place.
    await queryRunner.query(`DELETE FROM "student_question_states"`);
    await queryRunner.query(`
      INSERT INTO "student_question_states" (
        "user_id", "question_id", "first_correct_at", "times_seen", "times_correct",
        "best_time_ms", "xp_earned", "rating_applied", "created_at", "updated_at"
      )
      SELECT
        qs."user_id",
        qs."question_id",
        CASE WHEN qs."is_correct" THEN qs."created_at" ELSE NULL END,
        1,
        CASE WHEN qs."is_correct" THEN 1 ELSE 0 END,
        CASE WHEN qs."is_correct" THEN qs."time_ms" ELSE NULL END,
        qs."xp_awarded" > 0,
        NOT qs."suspicious",
        qs."created_at",
        qs."created_at"
      FROM "question_solves" qs
    `);

    // These values drive profile accuracy and the public leaderboard's solved
    // count. XP and ratings already used first-attempt guards, so they remain
    // authoritative and are not recalculated here.
    await queryRunner.query(`
      UPDATE "student_game_profiles" gp
      SET
        "total_solved" = (SELECT COUNT(*) FROM "question_solves" qs WHERE qs."user_id" = gp."user_id"),
        "total_correct" = (SELECT COUNT(*) FROM "question_solves" qs WHERE qs."user_id" = gp."user_id" AND qs."is_correct"),
        "total_wrong" = (SELECT COUNT(*) FROM "question_solves" qs WHERE qs."user_id" = gp."user_id" AND NOT qs."is_correct"),
        "total_time_ms" = COALESCE((SELECT SUM(qs."time_ms") FROM "question_solves" qs WHERE qs."user_id" = gp."user_id"), 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "question_solves"
      ADD CONSTRAINT "UQ_question_solves_user_question" UNIQUE ("user_id", "question_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_question_solves_subject_created"
      ON "question_solves" ("subject_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_question_solves_subject_created"`);
    await queryRunner.query(`
      ALTER TABLE "question_solves"
      DROP CONSTRAINT IF EXISTS "UQ_question_solves_user_question"
    `);
  }
}
