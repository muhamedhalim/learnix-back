import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Enforces draft-first lessons and stores durable server-issued TUS sessions. */
export class HardenLessonPublishingAndVideoUploads1990000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "status" SET DEFAULT 'draft'`);
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "version" integer NOT NULL DEFAULT 1`);
    await q.query(`
      CREATE TABLE "lesson_video_upload_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "lesson_id" uuid NOT NULL REFERENCES "lessons"("id") ON DELETE CASCADE,
        "teacher_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "bunny_video_id" varchar(255) NOT NULL,
        "previous_bunny_video_id" varchar(255),
        "status" varchar(24) NOT NULL DEFAULT 'created',
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz,
        "cleaned_at" timestamptz,
        "cleanup_attempts" integer NOT NULL DEFAULT 0,
        "last_cleanup_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lesson_video_upload_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_lesson_video_upload_sessions_status" CHECK ("status" IN ('created','completed','abandoned','cleanup_pending','cleaned'))
      )
    `);
    await q.query(`CREATE INDEX "IDX_lesson_video_upload_sessions_cleanup" ON "lesson_video_upload_sessions" ("status", "expires_at")`);
    await q.query(`CREATE INDEX "IDX_lesson_video_upload_sessions_lesson" ON "lesson_video_upload_sessions" ("lesson_id", "created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lesson_video_upload_sessions"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "version"`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "status" SET DEFAULT 'published'`);
  }
}
