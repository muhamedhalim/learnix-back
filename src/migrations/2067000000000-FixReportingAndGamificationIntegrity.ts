import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FixReportingAndGamificationIntegrity2067000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "is_public_profile" boolean NOT NULL DEFAULT false`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_student_profiles_is_public_profile" ON "student_profiles" ("is_public_profile")`);
    await q.query(`CREATE TABLE IF NOT EXISTS "streak_milestone_awards" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "days" integer NOT NULL, "awarded_at" TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT "UQ_streak_milestone_award_user_days" UNIQUE ("user_id", "days"))`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_streak_milestone_awards_user_id" ON "streak_milestone_awards" ("user_id")`);
    await q.query(`CREATE TABLE IF NOT EXISTS "practice_question_serves" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "question_id" uuid NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE, "served_at" TIMESTAMPTZ NOT NULL, CONSTRAINT "UQ_practice_question_serve_user_question" UNIQUE ("user_id", "question_id"))`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_practice_question_serves_user_id" ON "practice_question_serves" ("user_id")`);
    await q.query(`ALTER TABLE "teacher_reviews" ADD COLUMN IF NOT EXISTS "teacher_reply" text, ADD COLUMN IF NOT EXISTS "teacher_reply_at" TIMESTAMPTZ`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "teacher_reviews" DROP COLUMN IF EXISTS "teacher_reply_at", DROP COLUMN IF EXISTS "teacher_reply"`);
    await q.query(`DROP TABLE IF EXISTS "practice_question_serves"`);
    await q.query(`DROP TABLE IF EXISTS "streak_milestone_awards"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_student_profiles_is_public_profile"`);
    await q.query(`ALTER TABLE "student_profiles" DROP COLUMN IF EXISTS "is_public_profile"`);
  }
}
