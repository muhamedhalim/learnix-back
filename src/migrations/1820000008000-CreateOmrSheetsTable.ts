import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `omr_sheets`, backing the `OmrSheet` entity. No migration has ever
 * created this table — TypeORM's schema comparator confirms it as an
 * outright missing table (`CREATE TABLE` with no matching `DROP TABLE`,
 * unlike every other item in this audit which was a column-level gap on an
 * existing table).
 */
export class CreateOmrSheetsTable1820000008000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "omr_sheets_status_enum" AS ENUM ('pending','processing','completed','failed')`,
    );
    await q.query(`
      CREATE TABLE "omr_sheets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "exam_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "teacher_id" uuid NOT NULL,
        "image_key" character varying(500) NOT NULL,
        "detected_answers" jsonb NOT NULL,
        "status" "omr_sheets_status_enum" NOT NULL DEFAULT 'pending',
        "error_message" text,
        "attempt_id" uuid,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_omr_sheets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_omr_sheets_exam" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_omr_sheets_student" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_omr_sheets_teacher" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_omr_sheets_attempt" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE SET NULL
      )
    `);
    await q.query(`CREATE INDEX "IDX_omr_sheets_exam_id" ON "omr_sheets" ("exam_id")`);
    await q.query(`CREATE INDEX "IDX_omr_sheets_student_id" ON "omr_sheets" ("student_id")`);
    await q.query(`CREATE INDEX "IDX_omr_sheets_status" ON "omr_sheets" ("status")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "omr_sheets"`);
    await q.query(`DROP TYPE IF EXISTS "omr_sheets_status_enum"`);
  }
}
