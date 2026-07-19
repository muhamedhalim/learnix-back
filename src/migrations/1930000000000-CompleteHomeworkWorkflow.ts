import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completes the existing lesson-homework foundation with publishing,
 * structured questions, student submissions, grading, and notification types.
 */
export class CompleteHomeworkWorkflow1930000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'exam_assigned'`);
    await q.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'homework'`);

    await q.query(`
      ALTER TABLE "lesson_homework"
      ADD COLUMN "questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN "max_score" numeric(9,2) NOT NULL DEFAULT 100,
      ADD COLUMN "published_at" timestamptz
    `);

    await q.query(`
      CREATE TABLE "homework_submissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "homework_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "answer_text" text,
        "answers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "resource_url" varchar(1000),
        "status" varchar(20) NOT NULL DEFAULT 'submitted',
        "is_late" boolean NOT NULL DEFAULT false,
        "score" numeric(9,2),
        "feedback" text,
        "submitted_at" timestamptz NOT NULL,
        "graded_at" timestamptz,
        "graded_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_homework_submissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_homework_submissions_homework_student" UNIQUE ("homework_id", "student_id"),
        CONSTRAINT "FK_homework_submissions_homework" FOREIGN KEY ("homework_id")
          REFERENCES "lesson_homework"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_homework_submissions_student" FOREIGN KEY ("student_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_homework_submissions_grader" FOREIGN KEY ("graded_by")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_homework_submissions_status" CHECK ("status" IN ('submitted','graded')),
        CONSTRAINT "CHK_homework_submissions_score" CHECK ("score" IS NULL OR "score" >= 0)
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_homework_submissions_homework_id" ON "homework_submissions" ("homework_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_homework_submissions_student_id" ON "homework_submissions" ("student_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_homework_submissions_status" ON "homework_submissions" ("status")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "homework_submissions"`);
    await q.query(`
      ALTER TABLE "lesson_homework"
      DROP COLUMN IF EXISTS "published_at",
      DROP COLUMN IF EXISTS "max_score",
      DROP COLUMN IF EXISTS "questions"
    `);

    // PostgreSQL cannot remove enum labels in place. Rebuild the enum after
    // removing rows created by this feature so rollback remains deterministic.
    await q.query(`DELETE FROM "notifications" WHERE "type" IN ('exam_assigned','homework')`);
    await q.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE varchar USING "type"::text`,
    );
    await q.query(`DROP TYPE "notifications_type_enum"`);
    await q.query(
      `CREATE TYPE "notifications_type_enum" AS ENUM ('attendance','exam_result','lesson_expiring','purchase','custom','gamification')`,
    );
    await q.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "notifications_type_enum" USING "type"::"notifications_type_enum"`,
    );
  }
}
