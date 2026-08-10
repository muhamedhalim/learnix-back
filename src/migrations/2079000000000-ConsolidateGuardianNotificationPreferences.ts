import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-005 — collapse the duplicated guardian-event preference model.
 *
 * BEFORE: two independent models claimed to control the same guardian events.
 *   (a) `student_guardians.notification_preferences` — per (student, guardian),
 *       sparse `ParentEventType → boolean`, read by
 *       `GuardiansService.findNotificationTargets`, which is the ONLY thing the
 *       guardian dispatcher consults, and already edited by /student/guardians.
 *   (b) `notification_settings.notify_parent_on_*` — four global-per-student
 *       booleans, written by `PUT /notification-settings`, and read by NOTHING.
 *       Every one of them was a dead control.
 *
 * AFTER: (a) is the sole source of truth. (b) is gone.
 *
 * DETERMINISTIC RECONCILIATION RULE (applied per student, per guardian link):
 *
 *   A legacy `false` is migrated into the guardian link ONLY where that link has
 *   no explicit key for the mapped event. A legacy `true` is never migrated.
 *
 * Both halves of that rule are deliberate:
 *
 *   - Canonical wins on conflict. An explicit key in `notification_preferences`
 *     was written by the newer per-guardian UI, which is the surface that
 *     actually governed delivery; overwriting it with a value from a screen that
 *     never affected anything would change real, working behaviour.
 *   - `true` carries no information. Every mapped event defaults to `true` in
 *     `DEFAULT_PARENT_NOTIFICATION_PREFERENCES`, so a legacy `true` is
 *     indistinguishable from "never touched". Only an explicit `false` records a
 *     decision that would otherwise be lost, and only that is preserved.
 *
 * EVENT MAPPING
 *   notify_parent_on_attendance   → attendance_marked
 *   notify_parent_on_exam_grade   → exam_graded
 *   notify_on_purchase            → course_purchased
 *   notify_parent_on_lesson_expiry→ (none)
 *
 * `notify_parent_on_lesson_expiry` has no counterpart: there is no lesson-expiry
 * `ParentEventType` and no dispatcher has ever emitted one, so the flag could
 * not have suppressed a message even in principle. It is archived rather than
 * mapped (see below) so the decision stays inspectable.
 *
 * NOTHING IS DISCARDED. All four columns are copied verbatim into
 * `notification_settings_legacy_parent_toggles` before being dropped, which also
 * makes `down()` an exact restoration rather than a guess.
 *
 * DEPLOYMENT SAFETY. Dropping the columns would 500 an older instance that still
 * SELECTs them, so `UpdateNotificationSettingsDto` keeps accepting the four
 * field names (validated, ignored, documented as deprecated) for one release.
 * An old frontend build that still PUTs them therefore gets 200, not a 400 from
 * `forbidNonWhitelisted`.
 */
export class ConsolidateGuardianNotificationPreferences2079000000000 implements MigrationInterface {
  public name = 'ConsolidateGuardianNotificationPreferences2079000000000';

  public async up(q: QueryRunner): Promise<void> {
    const hasLegacy = await this.legacyColumnsExist(q);
    if (!hasLegacy) return;

    // ── 1. Archive, verbatim, before touching anything ──────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "notification_settings_legacy_parent_toggles" (
        "user_id" uuid NOT NULL,
        "notify_parent_on_attendance" boolean NOT NULL,
        "notify_parent_on_exam_grade" boolean NOT NULL,
        "notify_parent_on_lesson_expiry" boolean NOT NULL,
        "notify_on_purchase" boolean NOT NULL,
        "archived_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_settings_legacy_parent_toggles" PRIMARY KEY ("user_id")
      )
    `);
    await q.query(`
      INSERT INTO "notification_settings_legacy_parent_toggles"
        ("user_id", "notify_parent_on_attendance", "notify_parent_on_exam_grade",
         "notify_parent_on_lesson_expiry", "notify_on_purchase")
      SELECT "user_id", "notify_parent_on_attendance", "notify_parent_on_exam_grade",
             "notify_parent_on_lesson_expiry", "notify_on_purchase"
      FROM "notification_settings"
      ON CONFLICT ("user_id") DO NOTHING
    `);

    // ── 2. Reconcile explicit opt-outs into the canonical guardian model ────
    // `||` merges right-biased, so the existing map is placed on the RIGHT: any
    // key the link already holds survives untouched, and the legacy `false` is
    // only contributed where the canonical model is silent.
    const mapping: Array<{ column: string; event: string }> = [
      { column: 'notify_parent_on_attendance', event: 'attendance_marked' },
      { column: 'notify_parent_on_exam_grade', event: 'exam_graded' },
      { column: 'notify_on_purchase', event: 'course_purchased' },
    ];

    for (const { column, event } of mapping) {
      await q.query(
        `UPDATE "student_guardians" AS sg
            SET "notification_preferences" =
                  jsonb_build_object($1::text, false) || COALESCE(sg."notification_preferences", '{}'::jsonb),
                "updated_at" = now()
           FROM "notification_settings" AS ns
          WHERE ns."user_id" = sg."student_id"
            AND ns."${column}" = false
            AND NOT (COALESCE(sg."notification_preferences", '{}'::jsonb) ? $1::text)`,
        [event],
      );
    }

    // ── 3. Drop the duplicated model ───────────────────────────────────────
    for (const column of [
      'notify_parent_on_attendance',
      'notify_parent_on_exam_grade',
      'notify_parent_on_lesson_expiry',
      'notify_on_purchase',
    ]) {
      await q.query(`ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "${column}"`);
    }
  }

  /**
   * Restores the four columns from the archive. The guardian-side keys written
   * by `up()` are deliberately NOT unwound: by the time a revert happens a user
   * may have edited them through /student/guardians, and there is no way to tell
   * a migrated `false` from one they chose. Leaving them is the safe direction —
   * it preserves an opt-out rather than silently re-enabling messages to a
   * parent.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "notification_settings"
         ADD COLUMN IF NOT EXISTS "notify_parent_on_attendance" boolean NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS "notify_parent_on_exam_grade" boolean NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS "notify_parent_on_lesson_expiry" boolean NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS "notify_on_purchase" boolean NOT NULL DEFAULT true`,
    );

    const archiveExists = (await q.query(
      `SELECT to_regclass('public.notification_settings_legacy_parent_toggles') IS NOT NULL AS exists`,
    )) as Array<{ exists: boolean }>;
    if (archiveExists[0]?.exists !== true) return;

    await q.query(`
      UPDATE "notification_settings" AS ns
         SET "notify_parent_on_attendance"    = a."notify_parent_on_attendance",
             "notify_parent_on_exam_grade"    = a."notify_parent_on_exam_grade",
             "notify_parent_on_lesson_expiry" = a."notify_parent_on_lesson_expiry",
             "notify_on_purchase"             = a."notify_on_purchase"
        FROM "notification_settings_legacy_parent_toggles" AS a
       WHERE a."user_id" = ns."user_id"
    `);
  }

  private async legacyColumnsExist(q: QueryRunner): Promise<boolean> {
    const rows = (await q.query(
      `SELECT COUNT(*)::text AS count
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notification_settings'
          AND column_name = 'notify_parent_on_attendance'`,
    )) as Array<{ count: string }>;
    return Number(rows[0]?.count ?? '0') > 0;
  }
}
