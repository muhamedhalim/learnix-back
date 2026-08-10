import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-002 — Versioned Course + Snapshot (schema).
 *
 * Introduces `course_versions` / `course_version_items` as an immutable
 * curriculum-snapshot layer sitting alongside the existing, still-mutable
 * `lesson_package_items` ("current/live curriculum" — unchanged, still used
 * by teacher CMS editing, public preview, and catalogue listings).
 *
 * A version is a mutable draft while `locked_at IS NULL` (its content is
 * whatever `lesson_package_items` currently holds); the moment it is first
 * purchased it is locked forever, and its content is frozen into
 * `course_version_items` by `PaymentFinalizationService`. Two triggers make
 * that immutability a database guarantee, not just service-layer discipline:
 * a locked version's items can never be updated/deleted, and `locked_at`
 * itself can never be cleared or changed once set.
 *
 * Every existing `lesson_packages` row is bootstrapped with an unlocked
 * version 1 here so the system is self-consistent for all new activity the
 * moment this migration lands. Reconstructing historical versions for
 * packages that already have purchases (so old purchasers land on the
 * correct locked snapshot instead of all sharing this bootstrap draft) is a
 * separate, data-only migration: 2077000000000-BackfillPackageCourseVersions.
 */
export class AddCourseVersioning2076000000000 implements MigrationInterface {
  public name = 'AddCourseVersioning2076000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "course_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "package_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "locked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_course_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_course_versions_package_version" UNIQUE ("package_id", "version_number"),
        CONSTRAINT "FK_course_versions_package" FOREIGN KEY ("package_id")
          REFERENCES "lesson_packages"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_course_versions_package_id" ON "course_versions" ("package_id")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "course_version_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "order_index" integer NOT NULL DEFAULT 0,
        "chapter_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_course_version_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_course_version_items_version" FOREIGN KEY ("version_id")
          REFERENCES "course_versions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_course_version_items_lesson" FOREIGN KEY ("lesson_id")
          REFERENCES "lessons"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_course_version_items_version_id" ON "course_version_items" ("version_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_course_version_items_lesson_id" ON "course_version_items" ("lesson_id")`,
    );

    // ── lesson_packages.current_version_id ──────────────────────────────────
    await q.query(`ALTER TABLE "lesson_packages" ADD COLUMN IF NOT EXISTS "current_version_id" uuid`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_current_version_id" ON "lesson_packages" ("current_version_id")`,
    );
    // A plain `.catch()` on the JS promise would swallow the rejection but
    // NOT un-poison the surrounding SQL transaction — any statement issued
    // afterward in the same transaction would still fail with "current
    // transaction is aborted". Catch it inside Postgres instead.
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "lesson_packages"
          ADD CONSTRAINT "FK_lesson_packages_current_version" FOREIGN KEY ("current_version_id")
          REFERENCES "course_versions"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // ── package_purchases.course_version_id ─────────────────────────────────
    await q.query(
      `ALTER TABLE "package_purchases" ADD COLUMN IF NOT EXISTS "course_version_id" uuid`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_package_purchases_course_version_id" ON "package_purchases" ("course_version_id")`,
    );
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "package_purchases"
          ADD CONSTRAINT "FK_package_purchases_course_version" FOREIGN KEY ("course_version_id")
          REFERENCES "course_versions"("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // ── Immutability triggers ────────────────────────────────────────────────
    // A locked version's snapshot rows can never be changed or removed again.
    await q.query(`
      CREATE OR REPLACE FUNCTION enforce_course_version_item_immutability()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target_version_id uuid; version_locked_at timestamptz;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          target_version_id := OLD.version_id;
        ELSE
          target_version_id := NEW.version_id;
        END IF;
        SELECT locked_at INTO version_locked_at FROM course_versions
          WHERE id = target_version_id FOR SHARE;
        IF version_locked_at IS NOT NULL THEN
          RAISE EXCEPTION 'course_version_items is immutable once its version is locked'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS TRG_enforce_course_version_item_immutability ON course_version_items;
      CREATE TRIGGER TRG_enforce_course_version_item_immutability
      BEFORE UPDATE OR DELETE ON course_version_items
      FOR EACH ROW EXECUTE FUNCTION enforce_course_version_item_immutability()
    `);

    // A version can never be un-locked or have its lock timestamp changed.
    await q.query(`
      CREATE OR REPLACE FUNCTION enforce_course_version_no_unlock()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
          RAISE EXCEPTION 'course_versions.locked_at cannot change once set'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS TRG_enforce_course_version_no_unlock ON course_versions;
      CREATE TRIGGER TRG_enforce_course_version_no_unlock
      BEFORE UPDATE ON course_versions
      FOR EACH ROW EXECUTE FUNCTION enforce_course_version_no_unlock()
    `);

    // ── Bootstrap: every existing course gets an unlocked draft version 1 ───
    await q.query(`
      INSERT INTO "course_versions" ("package_id", "version_number", "locked_at")
      SELECT "id", 1, NULL FROM "lesson_packages"
      ON CONFLICT ("package_id", "version_number") DO NOTHING
    `);
    await q.query(`
      UPDATE "lesson_packages" lp
      SET "current_version_id" = cv."id"
      FROM "course_versions" cv
      WHERE cv."package_id" = lp."id" AND cv."version_number" = 1 AND lp."current_version_id" IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS TRG_enforce_course_version_no_unlock ON course_versions`);
    await q.query(`DROP FUNCTION IF EXISTS enforce_course_version_no_unlock()`);
    await q.query(
      `DROP TRIGGER IF EXISTS TRG_enforce_course_version_item_immutability ON course_version_items`,
    );
    await q.query(`DROP FUNCTION IF EXISTS enforce_course_version_item_immutability()`);

    await q.query(
      `ALTER TABLE "package_purchases" DROP CONSTRAINT IF EXISTS "FK_package_purchases_course_version"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_package_purchases_course_version_id"`);
    await q.query(`ALTER TABLE "package_purchases" DROP COLUMN IF EXISTS "course_version_id"`);

    await q.query(
      `ALTER TABLE "lesson_packages" DROP CONSTRAINT IF EXISTS "FK_lesson_packages_current_version"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_packages_current_version_id"`);
    await q.query(`ALTER TABLE "lesson_packages" DROP COLUMN IF EXISTS "current_version_id"`);

    await q.query(`DROP TABLE IF EXISTS "course_version_items"`);
    await q.query(`DROP TABLE IF EXISTS "course_versions"`);
  }
}
