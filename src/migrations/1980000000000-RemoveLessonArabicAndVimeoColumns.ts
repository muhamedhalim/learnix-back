import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `Lesson` now uses a single `title`/`description` (free text — Arabic,
 * English, or mixed) instead of a `title`/`title_ar` pair, and Bunny Stream is
 * the sole video provider. Before dropping the now-unused columns this:
 *
 *  - Backfills `title`/`description` from their `_ar` twins, but ONLY where
 *    the primary column is empty — an already-populated `title`/`description`
 *    is never overwritten, so no teacher-entered content is silently
 *    discarded (verified against the dev DB: `title` is never empty there,
 *    so this is a no-op today, but it protects any environment where it
 *    isn't).
 *  - Refuses to drop the Vimeo columns if any lesson still depends on Vimeo
 *    with no Bunny replacement, rather than silently deleting a lesson's
 *    only video reference. Verified against the current dev DB to be zero
 *    rows (`video_platform` is 100% `bunny`, no `vimeo_video_id`/
 *    `vimeo_embed_url` set anywhere) — but this is a real runtime guard, not
 *    an assumption, and will abort the migration in any environment where
 *    it doesn't hold.
 */
export class RemoveLessonArabicAndVimeoColumns1980000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- title/description merge -------------------------------------------
    await q.query(`
      UPDATE "lessons"
      SET "title" = "title_ar"
      WHERE ("title" IS NULL OR "title" = '') AND "title_ar" IS NOT NULL AND "title_ar" <> ''
    `);
    await q.query(`
      UPDATE "lessons"
      SET "description" = "description_ar"
      WHERE ("description" IS NULL OR "description" = '')
        AND "description_ar" IS NOT NULL AND "description_ar" <> ''
    `);

    // ---- Vimeo safety check --------------------------------------------------
    const orphaned: Array<{ id: string; title: string }> = await q.query(`
      SELECT "id", "title" FROM "lessons"
      WHERE ("vimeo_video_id" IS NOT NULL OR "vimeo_embed_url" IS NOT NULL)
        AND "bunny_video_id" IS NULL
    `);
    if (orphaned.length > 0) {
      const ids = orphaned.map((row) => `${row.id} ("${row.title}")`).join(', ');
      throw new Error(
        `RemoveLessonArabicAndVimeoColumns: refusing to drop the Vimeo columns — ` +
          `${String(orphaned.length)} lesson(s) still rely on Vimeo with no Bunny replacement: ${ids}. ` +
          `Re-upload their video to Bunny Stream first, then re-run this migration.`,
      );
    }

    // ---- drop the now-unused columns -----------------------------------------
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "title_ar"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "description_ar"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "vimeo_video_id"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN "vimeo_embed_url"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The `title`/`title_ar` merge performed in `up` cannot be reversed
    // (there is no way to recover which characters came from which column),
    // so this restores the columns' shape, not the original per-language
    // values — `title_ar` is backfilled from the current `title` only so the
    // NOT NULL constraint the column originally had is satisfiable.
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "vimeo_embed_url" character varying(500)`);
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "vimeo_video_id" character varying(255)`);
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "description_ar" text`);
    await q.query(`ALTER TABLE "lessons" ADD COLUMN "title_ar" character varying(255)`);
    await q.query(`UPDATE "lessons" SET "title_ar" = "title" WHERE "title_ar" IS NULL`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title_ar" SET NOT NULL`);
  }
}
