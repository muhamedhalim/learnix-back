import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the remaining mechanical drift found by this audit: plain
 * `TIMESTAMP` columns that should be `TIMESTAMPTZ` (the entities are typed
 * `timestamptz`; the raw DDL that created these tables used bare
 * `TIMESTAMP`), nullability constraints the entities enforce but the
 * original DDL didn't, and two bilingual title columns that were left
 * nullable in `InitialSchema` but are `NOT NULL` on `Lesson`/`LessonPackage`.
 *
 * For the two `title_ar` columns: no migration has ever backfilled Arabic
 * titles (they never existed), so this uses the English `title` as the
 * placeholder for any existing row — visibly a placeholder the teacher can
 * edit via the existing `_ar` editing UI, not a real translation. Left NULL
 * would violate the entity's own constraint; inventing a translation would
 * be a guess. Using the known-real English value is the only defensible
 * choice between those two.
 */
export class FixRemainingColumnDrift1820000007000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- users ---------------------------------------------------------------
    await q.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`);
    await q.query(`UPDATE "users" SET "is_active" = true WHERE "is_active" IS NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "is_active" SET NOT NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "refresh_token" TYPE text`);

    // ---- teacher_profiles ------------------------------------------------------
    await q.query(`UPDATE "teacher_profiles" SET "qualifications" = '' WHERE "qualifications" IS NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "qualifications" SET NOT NULL`);
    await q.query(`UPDATE "teacher_profiles" SET "years_of_experience" = 0 WHERE "years_of_experience" IS NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "years_of_experience" SET NOT NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "rating" SET NOT NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "total_ratings" SET NOT NULL`);

    // ---- student_profiles ------------------------------------------------------
    await q.query(`ALTER TABLE "student_profiles" ALTER COLUMN "grade_level" TYPE character varying(50)`);
    await q.query(`ALTER TABLE "student_profiles" ALTER COLUMN "school" TYPE character varying(150)`);
    await q.query(
      `ALTER TABLE "student_profiles" ADD COLUMN "notification_settings" jsonb NOT NULL DEFAULT '{}'`,
    );

    // ---- lessons: title_ar backfill + lengths ----------------------------------
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title" TYPE character varying(255)`);
    await q.query(`UPDATE "lessons" SET "title_ar" = "title" WHERE "title_ar" IS NULL`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title_ar" TYPE character varying(255)`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title_ar" SET NOT NULL`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "vimeo_video_id" TYPE character varying(255)`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "vimeo_embed_url" TYPE character varying(500)`);

    // ---- lesson_packages: title_ar backfill + lengths + timestamptz -----------
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title" TYPE character varying(255)`);
    await q.query(`UPDATE "lesson_packages" SET "title_ar" = "title" WHERE "title_ar" IS NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title_ar" TYPE character varying(255)`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title_ar" SET NOT NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "original_price" DROP NOT NULL`);
    await q.query(`UPDATE "lesson_packages" SET "is_active" = true WHERE "is_active" IS NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "is_active" SET NOT NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "deleted_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "lesson_package_items" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);

    // ---- guardian system --------------------------------------------------------
    // These tables' raw DDL (CreateGuardianSystem/CreateParentMessages) used
    // "TIMESTAMP WITH TIME ZONE", but the entities use bare @CreateDateColumn()/
    // @UpdateDateColumn() (plain `timestamp`, TypeORM's default when no `type`
    // is given) — the drift runs the opposite direction from every other
    // timestamp fix in this migration, confirmed against each entity directly.
    for (const [table, cols] of Object.entries({
      guardians: ['created_at', 'updated_at', 'deleted_at'],
      student_guardians: ['created_at', 'updated_at'],
      guardian_verifications: ['created_at'],
      parent_messages: ['created_at', 'updated_at'],
    })) {
      for (const col of cols) {
        await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${col}" TYPE TIMESTAMP`);
      }
    }

    // ---- activity_logs / audit_logs / user_sessions ----------------------------
    // Same as above: these entities declare plain `timestamp`
    // (ActivityLog/AuditLog use bare @CreateDateColumn(); UserSession's
    // `last_active`/`expires_at` are explicit `{ type: 'timestamp' }`).
    await q.query(`ALTER TABLE "activity_logs" ADD COLUMN "user_agent" character varying(255)`);
    await q.query(`ALTER TABLE "activity_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "activity_logs" ALTER COLUMN "deleted_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "audit_logs" ALTER COLUMN "target_name" TYPE character varying(200)`);
    await q.query(`ALTER TABLE "audit_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "expires_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "last_active" TYPE TIMESTAMP`);

    // ---- trivial length constraints (already-correct varchar, just unbounded) --
    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "title" TYPE character varying(200)`);

    // ---- cosmetic default alignment (no data risk) -----------------------------
    await q.query(`ALTER TABLE "teacher_reviews" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "teacher_reviews" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "lesson_reviews" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "lesson_reviews" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "complaints" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "complaints" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "comments" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "comments" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "comment_replies" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "comment_replies" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "lesson_progress" ALTER COLUMN "last_watched_at" DROP DEFAULT`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lesson_progress" ALTER COLUMN "last_watched_at" SET DEFAULT now()`);

    await q.query(`ALTER TABLE "notifications" ALTER COLUMN "title" TYPE character varying`);

    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "last_active" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "expires_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "user_sessions" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "audit_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "audit_logs" ALTER COLUMN "target_name" TYPE character varying`);
    await q.query(`ALTER TABLE "activity_logs" ALTER COLUMN "deleted_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "activity_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "activity_logs" DROP COLUMN "user_agent"`);

    for (const [table, cols] of Object.entries({
      parent_messages: ['created_at', 'updated_at'],
      guardian_verifications: ['created_at'],
      student_guardians: ['created_at', 'updated_at'],
      guardians: ['created_at', 'updated_at', 'deleted_at'],
    })) {
      for (const col of cols) {
        await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${col}" TYPE TIMESTAMP WITH TIME ZONE`);
      }
    }

    await q.query(`ALTER TABLE "lesson_package_items" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "deleted_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "updated_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "created_at" TYPE TIMESTAMP`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "is_active" DROP NOT NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "original_price" SET NOT NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title_ar" DROP NOT NULL`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title_ar" TYPE character varying`);
    await q.query(`ALTER TABLE "lesson_packages" ALTER COLUMN "title" TYPE character varying`);

    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "vimeo_embed_url" TYPE character varying`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "vimeo_video_id" TYPE character varying`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title_ar" DROP NOT NULL`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title_ar" TYPE character varying`);
    await q.query(`ALTER TABLE "lessons" ALTER COLUMN "title" TYPE character varying`);

    await q.query(`ALTER TABLE "student_profiles" DROP COLUMN "notification_settings"`);
    await q.query(`ALTER TABLE "student_profiles" ALTER COLUMN "school" TYPE character varying`);
    await q.query(`ALTER TABLE "student_profiles" ALTER COLUMN "grade_level" TYPE character varying`);

    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "total_ratings" DROP NOT NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "rating" DROP NOT NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "years_of_experience" DROP NOT NULL`);
    await q.query(`ALTER TABLE "teacher_profiles" ALTER COLUMN "qualifications" DROP NOT NULL`);

    await q.query(`ALTER TABLE "users" ALTER COLUMN "refresh_token" TYPE character varying`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "is_active" DROP NOT NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`);
  }
}
