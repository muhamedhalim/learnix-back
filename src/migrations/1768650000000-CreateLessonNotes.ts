import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal study notes (additive). One row per (user, lesson), autosaved from
 * the Study player. Private to the author; access to write is gated by the
 * same viewer check as signed playback.
 */
export class CreateLessonNotes1768650000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "lesson_notes" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "user_id" uuid NOT NULL,
         "lesson_id" uuid NOT NULL,
         "content" text NOT NULL DEFAULT '',
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_lesson_notes" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_lesson_notes_user_lesson" UNIQUE ("user_id", "lesson_id"),
         CONSTRAINT "FK_lesson_notes_user" FOREIGN KEY ("user_id")
           REFERENCES "users"("id") ON DELETE CASCADE,
         CONSTRAINT "FK_lesson_notes_lesson" FOREIGN KEY ("lesson_id")
           REFERENCES "lessons"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_notes_user_id" ON "lesson_notes" ("user_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_notes_lesson_id" ON "lesson_notes" ("lesson_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lesson_notes"`);
  }
}
