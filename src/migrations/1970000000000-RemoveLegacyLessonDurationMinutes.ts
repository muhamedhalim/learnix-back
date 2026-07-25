import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the legacy, unmapped minute-based duration column from lessons.
 *
 * Lesson duration is now optional and stored in seconds in `duration`, because
 * a lesson is created before a video is attached and its precise duration is
 * then populated from the video metadata. Migration 182 added that canonical
 * column, but retained the original NOT NULL `duration_minutes` column. New
 * inserts do not (and must not) write the obsolete field, so PostgreSQL
 * rejected otherwise valid lesson creation requests.
 */
export class RemoveLegacyLessonDurationMinutes1970000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasColumn('lessons', 'duration_minutes'))) return;

    // Preserve any historical value that was not backfilled by migration 182
    // before removing the obsolete source column.
    await q.query(`
      UPDATE "lessons"
      SET "duration" = "duration_minutes" * 60
      WHERE "duration" IS NULL AND "duration_minutes" IS NOT NULL
    `);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "duration_minutes"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await q.hasColumn('lessons', 'duration_minutes')) return;

    // This column is retained only for compatibility with a rollback to code
    // predating the seconds-based duration model. It is nullable because video
    // duration is legitimately unknown until a video is attached.
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "duration_minutes" integer`);
    await q.query(`
      UPDATE "lessons"
      SET "duration_minutes" = FLOOR("duration" / 60.0)::integer
      WHERE "duration" IS NOT NULL
    `);
  }
}
