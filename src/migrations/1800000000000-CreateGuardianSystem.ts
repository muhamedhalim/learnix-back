import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guardian system — replaces the three duplicated `parent_phone` columns with a
 * normalised Guardian aggregate.
 *
 * Before:
 *   users.parent_phone                        (nullable, written at registration, never read)
 *   student_profiles.parent_phone             (NOT NULL, source of truth for sending, often '')
 *   notification_settings.parent_phone_override (nullable, highest precedence)
 *
 * After:
 *   guardians               — one row per real person, keyed by canonical E.164
 *   student_guardians       — many-to-many link + per-pairing preferences
 *   guardian_verifications  — OTP challenges (hashed codes)
 *
 * Backfill precedence mirrors the behaviour of the code being replaced
 * (`NotificationsService.getParentPhone`): override → profile → users. Values
 * that cannot be normalised to E.164 (empty strings, the `01,12345678` shapes
 * the old regex let through) are skipped rather than imported as garbage.
 *
 * IMPORTANT — every backfilled guardian lands as `unverified`. Nobody's
 * ownership of those numbers was ever proven, so educational notifications stay
 * suppressed for them until an OTP is redeemed. This is a deliberate, visible
 * behaviour change: it is the whole point of the verification requirement.
 */
export class CreateGuardianSystem1800000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ---- enums -------------------------------------------------------------
    await q.query(
      `CREATE TYPE "guardians_preferred_language_enum" AS ENUM ('ar','en')`,
    );
    await q.query(
      `CREATE TYPE "guardians_verification_status_enum" AS ENUM ('unverified','pending','verified')`,
    );
    await q.query(
      `CREATE TYPE "student_guardians_relationship_enum" AS ENUM
         ('father','mother','grandparent','sibling','uncle','aunt','legal_guardian','other')`,
    );

    // ---- guardians ---------------------------------------------------------
    await q.query(`
      CREATE TABLE "guardians" (
        "id"                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "phone_e164"          character varying(20) NOT NULL,
        "full_name"           character varying(150),
        "preferred_language"  "guardians_preferred_language_enum" NOT NULL DEFAULT 'ar',
        "verification_status" "guardians_verification_status_enum" NOT NULL DEFAULT 'unverified',
        "verified_at"         TIMESTAMP WITH TIME ZONE,
        "whatsapp_capable"    boolean NOT NULL DEFAULT false,
        "opted_out_at"        TIMESTAMP WITH TIME ZONE,
        "created_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at"          TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_guardians_phone_e164" UNIQUE ("phone_e164")
      )`);
    await q.query(`CREATE INDEX "IDX_guardians_phone_e164" ON "guardians" ("phone_e164")`);
    await q.query(
      `CREATE INDEX "IDX_guardians_verification_status" ON "guardians" ("verification_status")`,
    );

    // ---- student_guardians -------------------------------------------------
    await q.query(`
      CREATE TABLE "student_guardians" (
        "id"                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "student_id"              uuid NOT NULL,
        "guardian_id"             uuid NOT NULL,
        "relationship"            "student_guardians_relationship_enum" NOT NULL DEFAULT 'other',
        "is_primary"              boolean NOT NULL DEFAULT false,
        "receives_notifications"  boolean NOT NULL DEFAULT true,
        "notification_preferences" jsonb NOT NULL DEFAULT '{}',
        "created_at"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "FK_student_guardians_student" FOREIGN KEY ("student_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_student_guardians_guardian" FOREIGN KEY ("guardian_id")
          REFERENCES "guardians"("id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE INDEX "IDX_student_guardians_student" ON "student_guardians" ("student_id")`);
    await q.query(`CREATE INDEX "IDX_student_guardians_guardian" ON "student_guardians" ("guardian_id")`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_student_guardians_pair" ON "student_guardians" ("student_id","guardian_id")`,
    );
    // At most one primary guardian per student. A partial unique index expresses
    // this exactly; a plain UNIQUE(student_id, is_primary) would also forbid two
    // non-primary guardians.
    await q.query(
      `CREATE UNIQUE INDEX "UQ_student_guardians_one_primary"
         ON "student_guardians" ("student_id") WHERE "is_primary"`,
    );

    // ---- guardian_verifications -------------------------------------------
    await q.query(`
      CREATE TABLE "guardian_verifications" (
        "id"           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "guardian_id"  uuid NOT NULL,
        "code_hash"    character varying(64) NOT NULL,
        "expires_at"   TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at"  TIMESTAMP WITH TIME ZONE,
        "attempts"     integer NOT NULL DEFAULT 0,
        "requested_by" uuid,
        "created_at"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "FK_guardian_verifications_guardian" FOREIGN KEY ("guardian_id")
          REFERENCES "guardians"("id") ON DELETE CASCADE
      )`);
    await q.query(
      `CREATE INDEX "IDX_guardian_verifications_guardian" ON "guardian_verifications" ("guardian_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_guardian_verifications_expires_at" ON "guardian_verifications" ("expires_at")`,
    );

    // ---- backfill ----------------------------------------------------------
    // Normalisation mirrors `src/common/utils/phone.util.ts` exactly. Anything
    // that does not match one of the three accepted shapes yields NULL and is
    // dropped — those rows never represented a reachable phone.
    await q.query(`
      CREATE TEMPORARY TABLE "tmp_guardian_backfill" AS
      WITH raw AS (
        SELECT
          u.id AS student_id,
          NULLIF(
            regexp_replace(
              COALESCE(
                NULLIF(ns."parent_phone_override", ''),
                NULLIF(sp."parent_phone", ''),
                NULLIF(u."parent_phone", '')
              ),
              '[^0-9+]', '', 'g'
            ),
            ''
          ) AS p
        FROM "users" u
        LEFT JOIN "student_profiles" sp ON sp."user_id" = u."id"
        LEFT JOIN "notification_settings" ns ON ns."user_id" = u."id"
        WHERE u."role" = 'student' AND u."deleted_at" IS NULL
      )
      SELECT
        student_id,
        CASE
          WHEN p ~ '^\\+201[0125][0-9]{8}$' THEN p
          WHEN p ~ '^201[0125][0-9]{8}$'    THEN '+' || p
          WHEN p ~ '^01[0125][0-9]{8}$'     THEN '+20' || substring(p from 2)
          ELSE NULL
        END AS phone_e164
      FROM raw
      WHERE p IS NOT NULL
    `);
    await q.query(`DELETE FROM "tmp_guardian_backfill" WHERE "phone_e164" IS NULL`);

    // One guardian per distinct number → siblings sharing a parent collapse to
    // a single row, which is the entire point of the new model.
    await q.query(`
      INSERT INTO "guardians" ("phone_e164", "whatsapp_capable", "verification_status")
      SELECT DISTINCT
        b."phone_e164",
        b."phone_e164" ~ '^\\+201[0125][0-9]{8}$',
        'unverified'::"guardians_verification_status_enum"
      FROM "tmp_guardian_backfill" b
      ON CONFLICT ("phone_e164") DO NOTHING
    `);

    await q.query(`
      INSERT INTO "student_guardians"
        ("student_id","guardian_id","relationship","is_primary","receives_notifications")
      SELECT b."student_id", g."id", 'other'::"student_guardians_relationship_enum", true, true
      FROM "tmp_guardian_backfill" b
      JOIN "guardians" g ON g."phone_e164" = b."phone_e164"
      ON CONFLICT ("student_id","guardian_id") DO NOTHING
    `);

    await q.query(`DROP TABLE "tmp_guardian_backfill"`);

    // ---- retire the duplicated columns -------------------------------------
    // `guardians` is now the single source of truth. Keeping these would let the
    // old write paths silently diverge again (they already had, on one row).
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "parent_phone"`);
    await q.query(`ALTER TABLE "student_profiles" DROP COLUMN IF EXISTS "parent_phone"`);
    await q.query(
      `ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "parent_phone_override"`,
    );
  }

  /**
   * Restores the three columns and repopulates them from the primary guardian.
   *
   * This is lossy by nature: the old schema cannot express multiple guardians,
   * so a student with two guardians comes back with only the primary one, and
   * the override/profile/users columns all receive that same value. Verification
   * state and per-event preferences have nowhere to go and are discarded.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "parent_phone" character varying`);
    await q.query(
      `ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "parent_phone" character varying(20)`,
    );
    await q.query(
      `ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "parent_phone_override" character varying(20)`,
    );

    await q.query(`
      UPDATE "users" u
      SET "parent_phone" = g."phone_e164"
      FROM "student_guardians" sg
      JOIN "guardians" g ON g."id" = sg."guardian_id"
      WHERE sg."student_id" = u."id" AND sg."is_primary"
    `);
    await q.query(`
      UPDATE "student_profiles" sp
      SET "parent_phone" = g."phone_e164"
      FROM "student_guardians" sg
      JOIN "guardians" g ON g."id" = sg."guardian_id"
      WHERE sg."student_id" = sp."user_id" AND sg."is_primary"
    `);
    // The pre-migration column was NOT NULL; empty string was the sentinel the
    // old registration path wrote when no parent phone was supplied.
    await q.query(`UPDATE "student_profiles" SET "parent_phone" = '' WHERE "parent_phone" IS NULL`);
    await q.query(`ALTER TABLE "student_profiles" ALTER COLUMN "parent_phone" SET NOT NULL`);

    await q.query(`DROP TABLE IF EXISTS "guardian_verifications"`);
    await q.query(`DROP TABLE IF EXISTS "student_guardians"`);
    await q.query(`DROP TABLE IF EXISTS "guardians"`);

    await q.query(`DROP TYPE IF EXISTS "student_guardians_relationship_enum"`);
    await q.query(`DROP TYPE IF EXISTS "guardians_verification_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "guardians_preferred_language_enum"`);
  }
}
