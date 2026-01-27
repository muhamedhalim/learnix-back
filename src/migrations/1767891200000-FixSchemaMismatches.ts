import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FixSchemaMismatches1767891200000 implements MigrationInterface {
  public name = 'FixSchemaMismatches1767891200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix Users table schema
    // 1. Add username column (initially nullable to allow data migration)
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" character varying;
    `);

    // 2. Migrate data: Set username = email (split before @) for existing records
    await queryRunner.query(`
      UPDATE "users"
      SET "username" = SPLIT_PART(email, '@', 1)
      WHERE "username" IS NULL;
    `);

    // 3. Make username unique and not null
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_users_username" UNIQUE ("username");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_username" ON "users" ("username");
    `);

    // 4. Replace full_name with first_name and last_name
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" character varying;
    `);

    // 5. Migrate full_name to first_name (if full_name exists)
    await queryRunner.query(`
      UPDATE "users"
      SET "first_name" = "full_name"
      WHERE "full_name" IS NOT NULL AND "first_name" IS NULL;
    `);

    // 6. Drop the old full_name column (now migrated to first_name)
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "full_name";
    `);

    // 7. Rename password to password_hash
    await queryRunner.query(`
      ALTER TABLE "users" RENAME COLUMN "password" TO "password_hash";
    `);

    // 8. Add missing user columns
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_picture_url" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login" timestamp;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refresh_token_id" character varying(64);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_refresh_token_id" ON "users" ("refresh_token_id");
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp;
    `);

    // Fix Teacher profiles table
    // Rename experience_years to years_of_experience
    await queryRunner.query(`
      ALTER TABLE "teacher_profiles" RENAME COLUMN "experience_years" TO "years_of_experience";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert teacher profiles
    await queryRunner.query(`
      ALTER TABLE "teacher_profiles" RENAME COLUMN "years_of_experience" TO "experience_years";
    `);

    // Revert users table
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "refresh_token_expires_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_refresh_token_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "refresh_token_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "last_login";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "is_active";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "profile_picture_url";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" RENAME COLUMN "password_hash" TO "password";
    `);
    // Restore full_name column before dropping first_name/last_name
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "full_name" character varying;
    `);
    await queryRunner.query(`
      UPDATE "users" SET "full_name" = "first_name" WHERE "first_name" IS NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "last_name";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "first_name";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_username";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_username";
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "username";
    `);
  }
}
