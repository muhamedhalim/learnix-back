import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMeetingProviderIntegration2089000000000 implements MigrationInterface {
  public name = 'AddMeetingProviderIntegration2089000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "teacher_meeting_accounts_provider_enum" AS ENUM
          ('google_meet', 'zoom', 'microsoft_teams', 'manual');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "teacher_meeting_account_status_enum" AS ENUM
          ('connected', 'expired', 'revoked', 'disconnected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "scheduled_lesson_sessions_meeting_provider_enum" AS ENUM
          ('google_meet', 'zoom', 'microsoft_teams', 'manual');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "scheduled_lesson_sessions_meeting_status_enum" AS ENUM
          ('not_required', 'not_requested', 'pending', 'creating', 'ready', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "teacher_meeting_accounts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "teacher_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "provider" "teacher_meeting_accounts_provider_enum" NOT NULL,
        "provider_account_id" varchar(255),
        "provider_account_email" varchar(320),
        "display_name" varchar(255),
        "access_token_encrypted" text,
        "refresh_token_encrypted" text,
        "token_expires_at" timestamptz,
        "scopes" text[],
        "status" "teacher_meeting_account_status_enum" NOT NULL DEFAULT 'connected',
        "last_verified_at" timestamptz,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teacher_meeting_accounts_teacher_provider"
      ON "teacher_meeting_accounts" ("teacher_id", "provider")
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_teacher_meeting_accounts_teacher" ON "teacher_meeting_accounts" ("teacher_id")`);

    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_provider" "scheduled_lesson_sessions_meeting_provider_enum"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_status" "scheduled_lesson_sessions_meeting_status_enum" NOT NULL DEFAULT 'not_required'`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "external_meeting_id" varchar(255)`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_host_url" varchar(2000)`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_passcode" varchar(64)`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_account_id" uuid`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_error" text`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_attempts" int NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_requested_at" timestamptz`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" ADD COLUMN IF NOT EXISTS "meeting_ready_at" timestamptz`);

    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "scheduled_lesson_sessions"
          ADD CONSTRAINT "FK_scheduled_sessions_meeting_account"
          FOREIGN KEY ("meeting_account_id") REFERENCES "teacher_meeting_accounts"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "scheduled_lesson_sessions"
          ADD CONSTRAINT "CHK_scheduled_lesson_sessions_https_meeting_host_url"
          CHECK ("meeting_host_url" IS NULL OR "meeting_host_url" ~* '^https://');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_sessions_meeting_status"
      ON "scheduled_lesson_sessions" ("meeting_status")
      WHERE "meeting_status" IN ('pending', 'creating', 'failed')
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_scheduled_sessions_external_meeting"
      ON "scheduled_lesson_sessions" ("meeting_provider", "external_meeting_id")
      WHERE "external_meeting_id" IS NOT NULL
    `);

    // Backfill (AD-10): no existing meeting is re-created and no existing row
    // needs teacher action. Group lessons never had meetings; individual slots
    // with a hand-typed URL are backfilled to a ready manual meeting, and
    // individual slots without one become the new "not requested" resting state.
    await q.query(`
      UPDATE "scheduled_lesson_sessions" session
      SET "meeting_provider" = 'manual', "meeting_status" = 'ready'
      FROM "lessons" lesson
      WHERE session."lesson_id" = lesson."id"
        AND lesson."is_group" = false
        AND session."meeting_url" IS NOT NULL
    `);
    await q.query(`
      UPDATE "scheduled_lesson_sessions" session
      SET "meeting_status" = 'not_requested'
      FROM "lessons" lesson
      WHERE session."lesson_id" = lesson."id"
        AND lesson."is_group" = false
        AND session."meeting_url" IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_scheduled_sessions_external_meeting"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_scheduled_sessions_meeting_status"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP CONSTRAINT IF EXISTS "CHK_scheduled_lesson_sessions_https_meeting_host_url"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP CONSTRAINT IF EXISTS "FK_scheduled_sessions_meeting_account"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_ready_at"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_requested_at"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_attempts"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_error"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_account_id"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_passcode"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_host_url"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "external_meeting_id"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_status"`);
    await q.query(`ALTER TABLE "scheduled_lesson_sessions" DROP COLUMN IF EXISTS "meeting_provider"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_teacher_meeting_accounts_teacher"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_teacher_meeting_accounts_teacher_provider"`);
    await q.query(`DROP TABLE IF EXISTS "teacher_meeting_accounts"`);

    await q.query(`DROP TYPE IF EXISTS "scheduled_lesson_sessions_meeting_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "scheduled_lesson_sessions_meeting_provider_enum"`);
    await q.query(`DROP TYPE IF EXISTS "teacher_meeting_account_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "teacher_meeting_accounts_provider_enum"`);
  }
}
