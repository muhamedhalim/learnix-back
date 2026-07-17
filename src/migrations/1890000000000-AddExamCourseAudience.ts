import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds explicit course audiences and enforces the valid exam-audience shapes. */
export class AddExamCourseAudience1890000000000 implements MigrationInterface {
  public readonly name = 'AddExamCourseAudience1890000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "exams" ADD COLUMN IF NOT EXISTS "package_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_exams_package_id" ON "exams" ("package_id")`,
    );

    // RESTRICT prevents deleting a target from widening a private exam into
    // the legacy instructor-roster audience. Soft deletion remains supported.
    await queryRunner.query(`
      DO $$
      DECLARE existing_constraint text;
      BEGIN
        FOR existing_constraint IN
          SELECT constraint_row.conname
          FROM pg_constraint constraint_row
          INNER JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
          INNER JOIN pg_attribute column_row
            ON column_row.attrelid = table_row.oid
           AND column_row.attnum = ANY(constraint_row.conkey)
          WHERE table_row.relname = 'exams'
            AND constraint_row.contype = 'f'
            AND column_row.attname = 'package_id'
        LOOP
          EXECUTE format('ALTER TABLE "exams" DROP CONSTRAINT %I', existing_constraint);
        END LOOP;

        ALTER TABLE "exams"
          ADD CONSTRAINT "FK_exams_package_id"
          FOREIGN KEY ("package_id") REFERENCES "lesson_packages"("id")
          ON DELETE RESTRICT NOT VALID;
      END $$
    `);
    await queryRunner.query(`ALTER TABLE "exams" VALIDATE CONSTRAINT "FK_exams_package_id"`);

    await queryRunner.query(`
      DO $$
      DECLARE existing_constraint text;
      BEGIN
        FOR existing_constraint IN
          SELECT constraint_row.conname
          FROM pg_constraint constraint_row
          INNER JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
          INNER JOIN pg_attribute column_row
            ON column_row.attrelid = table_row.oid
           AND column_row.attnum = ANY(constraint_row.conkey)
          WHERE table_row.relname = 'exams'
            AND constraint_row.contype = 'f'
            AND column_row.attname = 'lesson_id'
        LOOP
          EXECUTE format('ALTER TABLE "exams" DROP CONSTRAINT %I', existing_constraint);
        END LOOP;

        ALTER TABLE "exams"
          ADD CONSTRAINT "FK_exams_lesson_id"
          FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id")
          ON DELETE RESTRICT NOT VALID;
      END $$
    `);
    await queryRunner.query(`ALTER TABLE "exams" VALIDATE CONSTRAINT "FK_exams_lesson_id"`);

    // Legacy private rows with neither target remain valid. New writes are
    // stricter in ExamAuthoringService. The database rejects ambiguous or
    // public-with-private-target states regardless of the caller.
    await queryRunner.query(`
      ALTER TABLE "exams" DROP CONSTRAINT IF EXISTS "CK_exams_audience_shape";
      ALTER TABLE "exams" ADD CONSTRAINT "CK_exams_audience_shape" CHECK (
        ("is_public" = true AND "lesson_id" IS NULL AND "package_id" IS NULL)
        OR
        ("is_public" = false AND NOT ("lesson_id" IS NOT NULL AND "package_id" IS NOT NULL))
      ) NOT VALID
    `);
    await queryRunner.query(`ALTER TABLE "exams" VALIDATE CONSTRAINT "CK_exams_audience_shape"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const targeted = (await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "exams" WHERE "package_id" IS NOT NULL`,
    )) as { count: string }[];
    if (Number(targeted[0]?.count ?? 0) > 0) {
      throw new Error('Refusing to drop package_id while course-targeted exams exist');
    }

    await queryRunner.query(
      `ALTER TABLE "exams" DROP CONSTRAINT IF EXISTS "CK_exams_audience_shape"`,
    );
    await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT IF EXISTS "FK_exams_lesson_id"`);
    await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT IF EXISTS "FK_exams_package_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_exams_package_id"`);
    await queryRunner.query(`ALTER TABLE "exams" DROP COLUMN IF EXISTS "package_id"`);
  }
}
