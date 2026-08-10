import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-004: turns OMR from "client supplies pre-detected marks" into a real
 * image-recognition pipeline. Additive only — no existing `omr_sheets` row is
 * touched or deleted; `detected_answers`/`image_key` merely become nullable
 * (a freshly generated, unscanned sheet has neither yet; a historical row
 * already has both, unaffected by the relaxed constraint).
 *
 * `omr_sheets_status_enum` gets three new values (`review_required`, `ready`,
 * `confirmed`) alongside the four it already had — `pending`/`processing`/
 * `completed`/`failed` keep their exact original meaning.
 *
 * `exam_attempts.origin` distinguishes OMR-created attempts from online ones
 * (closes a cross-channel collision `AttemptService.createOmrAttempt` had no
 * way to detect); backfilled from the existing `omr_sheets.attempt_id` link
 * so historical OMR-graded attempts are labelled correctly too.
 */
export class AddOmrRecognitionPipeline2080000000000 implements MigrationInterface {
  public name = 'AddOmrRecognitionPipeline2080000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "omr_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "exam_id" uuid NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "content_hash" character varying(64) NOT NULL,
        "layout" jsonb NOT NULL,
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_omr_templates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_omr_templates_exam_version" UNIQUE ("exam_id", "version"),
        CONSTRAINT "FK_omr_templates_exam" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_omr_templates_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_omr_templates_exam_id" ON "omr_templates" ("exam_id")`,
    );

    // A freshly generated (unscanned) sheet has no image yet; a freshly
    // uploaded (unrecognized/unconfirmed) sheet has no final answers yet.
    await queryRunner.query(`ALTER TABLE "omr_sheets" ALTER COLUMN "image_key" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ALTER COLUMN "detected_answers" DROP NOT NULL`,
    );

    await queryRunner.query(`ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "template_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "recognized_answers" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "resolved_question_ids" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "recognition_provider" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "omr_sheets" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_omr_sheets_template') THEN
          ALTER TABLE "omr_sheets" ADD CONSTRAINT "FK_omr_sheets_template"
          FOREIGN KEY ("template_id") REFERENCES "omr_templates"("id") ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_omr_sheets_reviewer') THEN
          ALTER TABLE "omr_sheets" ADD CONSTRAINT "FK_omr_sheets_reviewer"
          FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_omr_sheets_template_id" ON "omr_sheets" ("template_id")`,
    );
    // At most one ACTIVE (non-terminal) sheet per (exam, student) at a time —
    // mirrors `UQ_exam_attempts_open_per_student`'s partial-unique pattern so
    // a duplicate generate/scan can't silently create a second sheet whose
    // answers get discarded by the other's confirm.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_omr_sheets_active_per_student"
      ON "omr_sheets" ("exam_id", "student_id")
      WHERE "status" NOT IN ('completed', 'failed')
    `);

    // Three new lifecycle states. Existing values (`pending`, `processing`,
    // `completed`, `failed`) are untouched — `completed` keeps meaning "final
    // graded state", exactly as it did before this pipeline existed.
    await queryRunner.query(
      `ALTER TYPE "omr_sheets_status_enum" ADD VALUE IF NOT EXISTS 'review_required'`,
    );
    await queryRunner.query(`ALTER TYPE "omr_sheets_status_enum" ADD VALUE IF NOT EXISTS 'ready'`);
    await queryRunner.query(
      `ALTER TYPE "omr_sheets_status_enum" ADD VALUE IF NOT EXISTS 'confirmed'`,
    );

    await queryRunner.query(
      `ALTER TABLE "exam_attempts" ADD COLUMN IF NOT EXISTS "origin" character varying(20) NOT NULL DEFAULT 'online'`,
    );
    await queryRunner.query(`
      UPDATE "exam_attempts" SET "origin" = 'omr'
      WHERE "id" IN (SELECT "attempt_id" FROM "omr_sheets" WHERE "attempt_id" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // omr_templates/the new omr_sheets columns can hold real, hard-to-reconstruct
    // recognition/review data once used — refuse a destructive rollback rather
    // than silently losing it, same guard style as AddCartCheckoutAggregation.
    const used = await queryRunner.query(
      `(SELECT 1 FROM "omr_templates" LIMIT 1)
       UNION ALL
       (SELECT 1 FROM "omr_sheets" WHERE "template_id" IS NOT NULL LIMIT 1)`,
    );
    if (used.length > 0) {
      throw new Error(
        'Cannot revert the OMR recognition pipeline migration after templates/recognized sheets exist',
      );
    }

    await queryRunner.query(`ALTER TABLE "exam_attempts" DROP COLUMN IF EXISTS "origin"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_omr_sheets_active_per_student"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omr_sheets_template_id"`);
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" DROP CONSTRAINT IF EXISTS "FK_omr_sheets_reviewer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" DROP CONSTRAINT IF EXISTS "FK_omr_sheets_template"`,
    );
    await queryRunner.query(`ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "reviewed_by"`);
    await queryRunner.query(`ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "confirmed_at"`);
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "recognition_provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "resolved_question_ids"`,
    );
    await queryRunner.query(`ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "recognized_answers"`);
    await queryRunner.query(`ALTER TABLE "omr_sheets" DROP COLUMN IF EXISTS "template_id"`);

    // Restoring NOT NULL is safe only because we just proved no row used the
    // new nullable window (the guard above already ran); legacy rows all had
    // both columns populated already.
    await queryRunner.query(
      `ALTER TABLE "omr_sheets" ALTER COLUMN "detected_answers" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "omr_sheets" ALTER COLUMN "image_key" SET NOT NULL`);

    await queryRunner.query(`DROP TABLE IF EXISTS "omr_templates"`);

    // Postgres cannot drop a single enum value without rebuilding the type;
    // `review_required`/`ready`/`confirmed` are left in place — same
    // deliberate no-op convention as AddTeacherMessageEventType/
    // ExtendComplaintsForCallCenterTickets.
  }
}
