import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subjects now use one locale-neutral display name. `name` was already the
 * required canonical column, so it remains the source of truth. The small
 * number of legacy rows with a blank primary name fall back to a non-blank
 * Arabic value; malformed rows with neither receive a deterministic ID-based
 * value rather than becoming invalid/null records.
 *
 * Subject thumbnails were only written by the management forms and returned
 * by the Subject API; no consumer rendered them. Their column is removed with
 * the obsolete bilingual name column after all consumers use `name`.
 */
export class UnifySubjectNameAndRemoveThumbnail2074000000000 implements MigrationInterface {
  public name = 'UnifySubjectNameAndRemoveThumbnail2074000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "subjects" subject
      SET "name" = btrim("name")
      WHERE btrim("name") <> '' AND "name" IS DISTINCT FROM btrim("name")
    `);
    await q.query(`
      UPDATE "subjects" subject
      SET "name" = CASE
        WHEN NULLIF(btrim("name_ar"), '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "subjects" existing
            WHERE existing."id" <> subject."id"
              AND existing."deleted_at" IS NULL
              AND lower(btrim(existing."name")) = lower(btrim(subject."name_ar"))
          )
          THEN btrim("name_ar")
        ELSE 'Subject ' || subject."id"::text
      END
      WHERE btrim("name") = ''
    `);
    await q.query(`ALTER TABLE "subjects" DROP COLUMN IF EXISTS "name_ar"`);
    await q.query(`ALTER TABLE "subjects" DROP COLUMN IF EXISTS "thumbnail"`);
  }

  /**
   * Columns can be restored structurally, but legacy translations/images
   * cannot be reconstructed after a deliberate feature removal.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "name_ar" varchar(255)`);
    await q.query(`ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "thumbnail" varchar(500)`);
  }
}
