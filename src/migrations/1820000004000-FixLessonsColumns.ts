import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes drift on `lessons`: `duration`, `is_group`, `available_for_days`,
 * `students_count` are on the entity but were never added by any migration.
 *
 * `duration` is not a blind rename of the old `duration_minutes` — the
 * entity's own comment marks it as seconds (`duration!: number | null; //
 * Duration in seconds`), so this backfills with `duration_minutes * 60`
 * rather than copying the raw value, which would under-report every
 * existing lesson's length by 60x. `duration_minutes` is left in place,
 * unmapped, rather than dropped.
 */
export class FixLessonsColumns1820000004000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "duration" integer`);
    await q.query(`UPDATE "lessons" SET "duration" = "duration_minutes" * 60`);

    await q.query(`ALTER TABLE "lessons" ADD COLUMN "is_group" boolean NOT NULL DEFAULT false`);
    await q.query(
      `ALTER TABLE "lessons" ADD COLUMN "available_for_days" integer NOT NULL DEFAULT 7`,
    );
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "students_count" integer NOT NULL DEFAULT 0`);

    await q.query(`UPDATE "lessons" SET "video_platform" = 'bunny' WHERE "video_platform" IS NULL`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "video_platform" SET NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "video_platform" DROP NOT NULL`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "students_count"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "available_for_days"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "is_group"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "duration"`);
  }
}
