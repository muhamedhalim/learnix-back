import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — per-lesson attachments and homework (additive).
 */
export class AddLessonContentTables1768629000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "lesson_attachments" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "lesson_id" uuid NOT NULL,
         "name" varchar(255) NOT NULL,
         "url" varchar(1000) NOT NULL,
         "type" varchar(30) NOT NULL DEFAULT 'other',
         "size_bytes" bigint,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_lesson_attachments" PRIMARY KEY ("id"),
         CONSTRAINT "FK_lesson_attachments_lesson" FOREIGN KEY ("lesson_id")
           REFERENCES "lessons"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_attachments_lesson_id" ON "lesson_attachments" ("lesson_id")`,
    );

    await q.query(
      `CREATE TABLE "lesson_homework" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "lesson_id" uuid NOT NULL,
         "title" varchar(255) NOT NULL,
         "description" text,
         "type" varchar(30) NOT NULL DEFAULT 'text',
         "resource_url" varchar(1000),
         "due_at" timestamptz,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now(),
         "deleted_at" timestamptz,
         CONSTRAINT "PK_lesson_homework" PRIMARY KEY ("id"),
         CONSTRAINT "FK_lesson_homework_lesson" FOREIGN KEY ("lesson_id")
           REFERENCES "lessons"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_homework_lesson_id" ON "lesson_homework" ("lesson_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lesson_homework"`);
    await q.query(`DROP TABLE IF EXISTS "lesson_attachments"`);
  }
}
