import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `subjects` an owner and a lifecycle so teachers can create them.
 *
 * Until now `subjects` was admin-only reference data: no owner column, no
 * status, and a duplicate-name check that lived purely in application code
 * (`SubjectsService.create`) using an exact, case-sensitive `=` comparison
 * with no backing constraint — so `"Physics"` and `"physics"` both inserted,
 * and two concurrent POSTs both succeeded.
 *
 * This migration adds:
 *   - `created_by_teacher_id` → `users(id)`, matching the `teacher_id → users(id)`
 *     convention every other content table uses. NULL means platform-owned.
 *   - `status` + a CHECK constraint. A `varchar` + CHECK is used deliberately
 *     rather than a Postgres enum: `data-source.ts` sets
 *     `migrationsTransactionMode: 'each'`, and `ALTER TYPE ... ADD VALUE`
 *     cannot run inside a transaction block, so adding a fifth status later
 *     would need an out-of-band migration. A CHECK is a plain DROP/ADD pair.
 *   - moderation bookkeeping (`rejection_reason`, `reviewed_by_admin_id`,
 *     `reviewed_at`).
 *   - `uq_subjects_name_ci`, closing the case/whitespace/race holes at the DB.
 *
 * `status` defaults to `'approved'`, which *is* the backfill for existing rows
 * — no UPDATE needed. The default stays `'approved'` permanently rather than
 * being flipped to `'pending_approval'` afterwards: raw-SQL seeds (e.g.
 * `test/e2e/certificates.e2e-spec.ts`) insert subjects without a status, and a
 * pending default would silently hide them from every read path. The fail-safe
 * lives in `SubjectsService.createByTeacher`, which always sets the status
 * explicitly.
 *
 * `CREATE INDEX CONCURRENTLY` is not usable here (the migration runs inside a
 * transaction). `subjects` is a small table, so the brief ACCESS EXCLUSIVE lock
 * taken by the plain `CREATE UNIQUE INDEX` is acceptable.
 */
export class AddSubjectOwnershipAndStatus2070000000000 implements MigrationInterface {
  public name = 'AddSubjectOwnershipAndStatus2070000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-flight: `uq_subjects_name_ci` cannot be created if two live rows
    // already collide once case and surrounding whitespace are normalized.
    // Fail loudly instead of mutating data — six FK tables plus three
    // unconstrained gamification tables (`question_solves`,
    // `practice_sessions`, `student_subject_ratings`) reference `subjects.id`,
    // so silently soft-deleting a "loser" row would orphan paid content.
    // Resolve collisions by hand (rename or merge, repointing every reference)
    // before running this migration.
    const collisions = (await queryRunner.query(`
      SELECT lower(btrim("name")) AS key,
             count(*) AS n,
             array_agg("id"::text) AS ids
      FROM "subjects"
      WHERE "deleted_at" IS NULL
      GROUP BY 1
      HAVING count(*) > 1
    `)) as { key: string; n: string; ids: string[] }[];

    if (collisions.length > 0) {
      const detail = collisions
        .map((row) => `  "${row.key}" (${row.n} rows): ${row.ids.join(', ')}`)
        .join('\n');
      throw new Error(
        'Cannot create uq_subjects_name_ci: existing subjects collide on ' +
          `lower(btrim(name)).\n${detail}\n` +
          'Rename or merge these subjects (repointing lessons, lesson_packages, ' +
          'exams, questions, books, teacher_subjects and the gamification tables) ' +
          'before running this migration.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE "subjects"
        ADD COLUMN IF NOT EXISTS "created_by_teacher_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "status" character varying(20) NOT NULL DEFAULT 'approved',
        ADD COLUMN IF NOT EXISTS "rejection_reason" text NULL,
        ADD COLUMN IF NOT EXISTS "reviewed_by_admin_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "subjects"
        ADD CONSTRAINT "CHK_subjects_status"
        CHECK ("status" IN ('pending_approval', 'approved', 'rejected', 'suspended'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // ON DELETE SET NULL, not CASCADE: a hard-deleted teacher should demote
    // their subjects to platform-owned, never delete catalogue rows that other
    // teachers' lessons, courses, exams and books already point at.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "subjects"
        ADD CONSTRAINT "FK_subjects_created_by_teacher"
        FOREIGN KEY ("created_by_teacher_id") REFERENCES "users"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subjects_status" ON "subjects" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_subjects_created_by_teacher_id"
      ON "subjects" ("created_by_teacher_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_subjects_name_ci"
      ON "subjects" (lower(btrim("name")))
      WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_subjects_name_ci"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subjects_created_by_teacher_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subjects_status"`);
    await queryRunner.query(`
      ALTER TABLE "subjects" DROP CONSTRAINT IF EXISTS "FK_subjects_created_by_teacher"
    `);
    await queryRunner.query(`
      ALTER TABLE "subjects" DROP CONSTRAINT IF EXISTS "CHK_subjects_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "subjects"
        DROP COLUMN IF EXISTS "reviewed_at",
        DROP COLUMN IF EXISTS "reviewed_by_admin_id",
        DROP COLUMN IF EXISTS "rejection_reason",
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "created_by_teacher_id"
    `);
  }
}
