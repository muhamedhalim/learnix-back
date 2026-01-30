import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateUserRegistration1736445601000 implements MigrationInterface {
  public name = 'UpdateUserRegistration1736445601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add "name" column if missing, fill values, then set NOT NULL
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "name" character varying
    `);

    await queryRunner.query(`
      UPDATE "users"
      SET "name" = COALESCE("full_name", email)
      WHERE "name" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "name" SET NOT NULL
    `);

    // Add "parent_phone" column if missing
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "parent_phone" character varying
    `);

    // Create index for parent_phone if it doesn't exist
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_parent_phone" ON "users" ("parent_phone")
    `);

    // Ensure phone column has values and is NOT NULL
    await queryRunner.query(`
      UPDATE "users" SET "phone" = CONCAT('temp_', id::text)
      WHERE "phone" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "phone" SET NOT NULL
    `);

    // --- Idempotent creation of unique constraint "UQ_users_phone" ---
    // Postgres doesn't support ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS,
    // so check table metadata and only create if absent.
    const table = await queryRunner.getTable('users');

    const hasPhoneUnique =
      (table?.uniques ?? []).some((u) => u.name === 'UQ_users_phone') ||
      (table?.indices ?? []).some((i) => i.name === 'UQ_users_phone');

    if (!hasPhoneUnique) {
      await queryRunner.query(`
        ALTER TABLE "users"
        ADD CONSTRAINT "UQ_users_phone" UNIQUE ("phone")
      `);
    }
    // ------------------------------------------------------------------
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the unique constraint if it exists
    // Use defensive SQL to avoid errors if absent
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'UQ_users_phone'
        ) THEN
          ALTER TABLE "users" DROP CONSTRAINT "UQ_users_phone";
        END IF;
      END$$;
    `);

    // Drop the parent_phone index if exists
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_parent_phone";
    `);

    // Optionally keep data; below lines remove the added columns if you want to fully revert:
    // Note: drop columns only if you are sure you want to remove them.
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "parent_phone";`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "name";`,
    );
  }
}
