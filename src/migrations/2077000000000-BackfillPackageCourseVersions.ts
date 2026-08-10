import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-002 — Versioned Course + Snapshot (data backfill).
 *
 * The 2076000000000-AddCourseVersioning migration gave every existing course
 * a single unlocked "version 1" bootstrap row. This migration reconstructs
 * *historical* versions for courses that already have purchases, so an old
 * purchaser lands on a locked snapshot that actually matches what they hold
 * — rather than every purchaser sharing one assumed curriculum, which would
 * be wrong whenever the course's curriculum changed between purchases (the
 * very bug DEF-002 fixes).
 *
 * For each purchase, the most trustworthy available evidence of "what did
 * this student actually receive" is the set of `lesson_purchases` rows that
 * share its `payment_id` — the same durable, per-lesson grant that lesson
 * content access already authorizes against. Distinct lesson-sets for the
 * same package become distinct locked versions, numbered by earliest
 * purchase ascending; the earliest reuses the already-existing version 1 row
 * instead of creating a duplicate. One further unlocked version is created
 * per course that has purchases, mirroring current live curriculum, so new
 * purchases going forward snapshot from it.
 *
 * Known, documented limitation: a purchase whose `payment_id` has zero
 * matching `lesson_purchases` rows (no evidence at all — a very old row
 * predating even the 1768...BackfillPackageLessonAccessWindows migration,
 * or one that migration itself could not reconstruct because live curriculum
 * had already drifted by the time *it* ran) falls back to today's live
 * `lesson_package_items` for that one purchase's snapshot. This is the
 * least-destructive deterministic choice available — exact historical
 * reconstruction is impossible without evidence that no longer exists.
 *
 * Purely additive: never deletes or mutates `lesson_purchases`, `payments`,
 * `entitlements`, or certificate data.
 */
export class BackfillPackageCourseVersions2077000000000 implements MigrationInterface {
  public name = 'BackfillPackageCourseVersions2077000000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Fingerprint every not-yet-backfilled purchase from LessonPurchase
    //    evidence, falling back to live curriculum when there is none.
    await q.query(`
      CREATE TEMP TABLE tmp_purchase_fingerprint ON COMMIT DROP AS
      SELECT
        pp.id AS purchase_id,
        pp.package_id,
        pp.purchased_at,
        CASE
          WHEN evidence.lesson_ids IS NOT NULL THEN evidence.lesson_ids
          ELSE COALESCE(live.lesson_ids, ARRAY[]::uuid[])
        END AS lesson_ids
      FROM package_purchases pp
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT lp.lesson_id ORDER BY lp.lesson_id) AS lesson_ids
        FROM lesson_purchases lp
        WHERE lp.payment_id = pp.payment_id
      ) evidence ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT item.lesson_id ORDER BY item.lesson_id) AS lesson_ids
        FROM lesson_package_items item
        WHERE item.package_id = pp.package_id
      ) live ON true
      WHERE pp.course_version_id IS NULL
    `);

    // 2. Distinct (package, curriculum-fingerprint) groups, numbered by
    //    earliest purchase ascending — each becomes one locked version.
    await q.query(`
      CREATE TEMP TABLE tmp_version_groups ON COMMIT DROP AS
      SELECT
        package_id,
        lesson_ids,
        MIN(purchased_at) AS earliest_purchased_at,
        ROW_NUMBER() OVER (PARTITION BY package_id ORDER BY MIN(purchased_at) ASC) AS version_number
      FROM tmp_purchase_fingerprint
      GROUP BY package_id, lesson_ids
    `);

    // 3a. The earliest group reuses the existing unlocked version 1 row.
    await q.query(`
      UPDATE course_versions cv
      SET locked_at = g.earliest_purchased_at
      FROM tmp_version_groups g
      WHERE g.version_number = 1
        AND cv.package_id = g.package_id
        AND cv.version_number = 1
        AND cv.locked_at IS NULL
    `);

    // 3b. Later groups get new locked version rows.
    await q.query(`
      INSERT INTO course_versions (package_id, version_number, locked_at)
      SELECT package_id, version_number, earliest_purchased_at
      FROM tmp_version_groups
      WHERE version_number > 1
      ON CONFLICT (package_id, version_number) DO NOTHING
    `);

    // 4. Snapshot each group's curriculum into course_version_items.
    await q.query(`
      INSERT INTO course_version_items (version_id, lesson_id, order_index)
      SELECT cv.id, item.lesson_id, item.ord - 1
      FROM tmp_version_groups g
      JOIN course_versions cv
        ON cv.package_id = g.package_id AND cv.version_number = g.version_number
      CROSS JOIN LATERAL unnest(g.lesson_ids) WITH ORDINALITY AS item(lesson_id, ord)
      WHERE NOT EXISTS (
        SELECT 1 FROM course_version_items existing WHERE existing.version_id = cv.id
      )
    `);

    // 5. One more unlocked "current" version per course that has purchases —
    //    new purchases going forward lock/snapshot from this one.
    await q.query(`
      INSERT INTO course_versions (package_id, version_number, locked_at)
      SELECT package_id, MAX(version_number) + 1, NULL
      FROM tmp_version_groups
      GROUP BY package_id
      ON CONFLICT (package_id, version_number) DO NOTHING
    `);
    await q.query(`
      UPDATE lesson_packages lp
      SET current_version_id = cv.id
      FROM (
        SELECT g.package_id, MAX(g.version_number) + 1 AS version_number
        FROM tmp_version_groups g
        GROUP BY g.package_id
      ) latest
      JOIN course_versions cv
        ON cv.package_id = latest.package_id AND cv.version_number = latest.version_number
      WHERE lp.id = latest.package_id
    `);

    // 6. Point every backfilled purchase at its matching version.
    await q.query(`
      UPDATE package_purchases pp
      SET course_version_id = cv.id
      FROM tmp_purchase_fingerprint tpf
      JOIN tmp_version_groups g
        ON g.package_id = tpf.package_id AND g.lesson_ids = tpf.lesson_ids
      JOIN course_versions cv
        ON cv.package_id = g.package_id AND cv.version_number = g.version_number
      WHERE pp.id = tpf.purchase_id
    `);
  }

  /**
   * Deliberately retains every backfilled version/snapshot on rollback —
   * matching the policy already established by
   * 2073000000000-BackfillPackageLessonAccessWindows. Removing it would
   * discard reconstructed purchase history and could unexpectedly change
   * which curriculum a student's completion is judged against.
   */
  public async down(_q: QueryRunner): Promise<void> {}
}
