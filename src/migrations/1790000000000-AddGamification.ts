import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gamification & Competitive Question Bank — Milestone 1 (additive only).
 *
 * - Adds `expert` to the existing question difficulty enum.
 * - Adds optional demographic columns to `student_profiles` (public geo boards).
 * - Creates the gamification tables: rank tiers, per-student game profile,
 *   per-subject Elo ratings, the anti-farming solved-set, the append-only solve
 *   and XP ledgers, and practice sessions.
 * - Seeds the rank-tier ladder.
 *
 * Nothing existing is altered/dropped, so exams/attempts/lessons are untouched.
 */
export class AddGamification1790000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- difficulty enum: add EXPERT ---------------------------------------
    await q.query(
      `ALTER TYPE "questions_difficulty_enum" ADD VALUE IF NOT EXISTS 'expert'`,
    );

    // ---- notifications type enum: add GAMIFICATION -------------------------
    await q.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'gamification'`,
    );

    // ---- student_profiles: optional geo fields -----------------------------
    await q.query(
      `ALTER TABLE "student_profiles"
         ADD COLUMN IF NOT EXISTS "country" character varying(100),
         ADD COLUMN IF NOT EXISTS "governorate" character varying(100),
         ADD COLUMN IF NOT EXISTS "school" character varying(150)`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_student_profiles_country" ON "student_profiles" ("country")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_student_profiles_governorate" ON "student_profiles" ("governorate")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_student_profiles_school" ON "student_profiles" ("school")`);

    // ---- enums -------------------------------------------------------------
    await q.query(
      `CREATE TYPE "question_solves_difficulty_enum" AS ENUM ('easy','medium','hard','expert')`,
    );
    await q.query(
      `CREATE TYPE "practice_sessions_difficulty_enum" AS ENUM ('easy','medium','hard','expert')`,
    );
    await q.query(
      `CREATE TYPE "xp_events_reason_enum" AS ENUM ('correct_answer','combo_bonus','streak_daily','streak_milestone','perfect_exam','lesson_completion','course_completion','daily_challenge','weekly_challenge','achievement')`,
    );

    // ---- rank_tiers --------------------------------------------------------
    await q.query(
      `CREATE TABLE "rank_tiers" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "slug" character varying(50) NOT NULL,
         "name" character varying(50) NOT NULL,
         "icon_key" character varying(50) NOT NULL,
         "color" character varying(20) NOT NULL,
         "min_rating" numeric(8,2) NOT NULL DEFAULT 0,
         "min_xp" bigint NOT NULL DEFAULT 0,
         "sort_order" integer NOT NULL DEFAULT 0,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_rank_tiers" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_rank_tiers_slug" UNIQUE ("slug")
       )`,
    );

    // ---- student_game_profiles --------------------------------------------
    await q.query(
      `CREATE TABLE "student_game_profiles" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "xp" bigint NOT NULL DEFAULT 0,
         "level" integer NOT NULL DEFAULT 1,
         "global_rating" numeric(8,2) NOT NULL DEFAULT 1200,
         "current_streak" integer NOT NULL DEFAULT 0,
         "longest_streak" integer NOT NULL DEFAULT 0,
         "last_active_date" date,
         "current_combo" integer NOT NULL DEFAULT 0,
         "longest_combo" integer NOT NULL DEFAULT 0,
         "total_solved" integer NOT NULL DEFAULT 0,
         "total_correct" integer NOT NULL DEFAULT 0,
         "total_wrong" integer NOT NULL DEFAULT 0,
         "total_time_ms" bigint NOT NULL DEFAULT 0,
         "rank_tier_id" uuid,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_student_game_profiles" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_student_game_profiles_user_id" UNIQUE ("user_id"),
         CONSTRAINT "FK_student_game_profiles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
         CONSTRAINT "FK_student_game_profiles_rank" FOREIGN KEY ("rank_tier_id") REFERENCES "rank_tiers"("id") ON DELETE SET NULL
       )`,
    );
    await q.query(`CREATE INDEX "IDX_student_game_profiles_user_id" ON "student_game_profiles" ("user_id")`);
    await q.query(`CREATE INDEX "IDX_student_game_profiles_xp" ON "student_game_profiles" ("xp")`);
    await q.query(`CREATE INDEX "IDX_student_game_profiles_global_rating" ON "student_game_profiles" ("global_rating")`);

    // ---- student_subject_ratings ------------------------------------------
    await q.query(
      `CREATE TABLE "student_subject_ratings" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "subject_id" uuid NOT NULL,
         "rating" numeric(8,2) NOT NULL DEFAULT 1200,
         "solved" integer NOT NULL DEFAULT 0,
         "correct" integer NOT NULL DEFAULT 0,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_student_subject_ratings" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_student_subject_ratings_user_subject" UNIQUE ("user_id","subject_id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_student_subject_ratings_user_id" ON "student_subject_ratings" ("user_id")`);
    await q.query(`CREATE INDEX "IDX_student_subject_ratings_board" ON "student_subject_ratings" ("subject_id","rating")`);

    // ---- student_question_states (anti-farming solved set) -----------------
    await q.query(
      `CREATE TABLE "student_question_states" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "question_id" uuid NOT NULL,
         "first_correct_at" TIMESTAMP WITH TIME ZONE,
         "times_seen" integer NOT NULL DEFAULT 0,
         "times_correct" integer NOT NULL DEFAULT 0,
         "best_time_ms" integer,
         "xp_earned" boolean NOT NULL DEFAULT false,
         "rating_applied" boolean NOT NULL DEFAULT false,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_student_question_states" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_student_question_states_user_question" UNIQUE ("user_id","question_id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_student_question_states_user_id" ON "student_question_states" ("user_id")`);

    // ---- question_solves (append-only ledger) ------------------------------
    await q.query(
      `CREATE TABLE "question_solves" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "question_id" uuid NOT NULL,
         "question_version" integer NOT NULL,
         "subject_id" uuid NOT NULL,
         "lesson_id" uuid,
         "difficulty" "question_solves_difficulty_enum" NOT NULL,
         "response" jsonb,
         "is_correct" boolean NOT NULL,
         "time_ms" integer NOT NULL DEFAULT 0,
         "xp_awarded" integer NOT NULL DEFAULT 0,
         "rating_delta" numeric(8,2) NOT NULL DEFAULT 0,
         "combo_at_time" integer NOT NULL DEFAULT 0,
         "first_solve" boolean NOT NULL DEFAULT false,
         "suspicious" boolean NOT NULL DEFAULT false,
         "session_id" uuid,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_question_solves" PRIMARY KEY ("id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_question_solves_user_created" ON "question_solves" ("user_id","created_at")`);
    await q.query(`CREATE INDEX "IDX_question_solves_question_id" ON "question_solves" ("question_id")`);
    await q.query(`CREATE INDEX "IDX_question_solves_created_at" ON "question_solves" ("created_at")`);

    // ---- xp_events (append-only ledger) ------------------------------------
    await q.query(
      `CREATE TABLE "xp_events" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "amount" integer NOT NULL,
         "reason" "xp_events_reason_enum" NOT NULL,
         "ref_id" uuid,
         "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_xp_events" PRIMARY KEY ("id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_xp_events_user_occurred" ON "xp_events" ("user_id","occurred_at")`);
    await q.query(`CREATE INDEX "IDX_xp_events_occurred_at" ON "xp_events" ("occurred_at")`);

    // ---- practice_sessions -------------------------------------------------
    await q.query(
      `CREATE TABLE "practice_sessions" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "subject_id" uuid,
         "difficulty" "practice_sessions_difficulty_enum",
         "answered_count" integer NOT NULL DEFAULT 0,
         "correct_count" integer NOT NULL DEFAULT 0,
         "combo_peak" integer NOT NULL DEFAULT 0,
         "ended_at" TIMESTAMP WITH TIME ZONE,
         "started_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_practice_sessions" PRIMARY KEY ("id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_practice_sessions_user_id" ON "practice_sessions" ("user_id")`);

    // ---- seed rank tiers ---------------------------------------------------
    await q.query(
      `INSERT INTO "rank_tiers" ("slug","name","icon_key","color","min_rating","min_xp","sort_order") VALUES
         ('bronze','Bronze','bronze','#CD7F32',0,0,1),
         ('silver','Silver','silver','#C0C0C0',1200,500,2),
         ('gold','Gold','gold','#FFD700',1450,2000,3),
         ('diamond','Diamond','diamond','#4FC3F7',1700,6000,4),
         ('legend','Legend','legend','#B388FF',1950,15000,5)
       ON CONFLICT ("slug") DO NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "practice_sessions"`);
    await q.query(`DROP TABLE IF EXISTS "xp_events"`);
    await q.query(`DROP TABLE IF EXISTS "question_solves"`);
    await q.query(`DROP TABLE IF EXISTS "student_question_states"`);
    await q.query(`DROP TABLE IF EXISTS "student_subject_ratings"`);
    await q.query(`DROP TABLE IF EXISTS "student_game_profiles"`);
    await q.query(`DROP TABLE IF EXISTS "rank_tiers"`);
    await q.query(`DROP TYPE IF EXISTS "xp_events_reason_enum"`);
    await q.query(`DROP TYPE IF EXISTS "practice_sessions_difficulty_enum"`);
    await q.query(`DROP TYPE IF EXISTS "question_solves_difficulty_enum"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_student_profiles_school"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_student_profiles_governorate"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_student_profiles_country"`);
    await q.query(
      `ALTER TABLE "student_profiles" DROP COLUMN IF EXISTS "school", DROP COLUMN IF EXISTS "governorate", DROP COLUMN IF EXISTS "country"`,
    );
    // Note: Postgres cannot drop a single enum value, so 'expert' on
    // questions_difficulty_enum is intentionally left in place (harmless).
  }
}
