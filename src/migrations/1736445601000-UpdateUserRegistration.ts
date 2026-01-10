import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateUserRegistration1736445601000 implements MigrationInterface {
  name = 'UpdateUserRegistration1736445601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add new name column (combining first_name and last_name)
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "name" character varying
    `);

    // Migrate existing data: combine first_name and last_name into name
    await queryRunner.query(`
      UPDATE "users"
      SET "name" = COALESCE(TRIM(CONCAT(first_name, ' ', last_name)), email)
      WHERE "name" IS NULL
    `);

    // Make name NOT NULL after data migration
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL
    `);

    // Add parent_phone column
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "parent_phone" character varying
    `);

    // Create index on parent_phone
    await queryRunner.query(`
      CREATE INDEX "IDX_users_parent_phone" ON "users" ("parent_phone")
    `);

    // Make phone unique and not null (set default for existing records first)
    await queryRunner.query(`
      UPDATE "users" SET "phone" = CONCAT('temp_', id::text)
      WHERE "phone" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "phone" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_users_phone" UNIQUE ("phone")
    `);

    // Create index on phone
    await queryRunner.query(`
      CREATE INDEX "IDX_users_phone" ON "users" ("phone")
    `);

    // Drop username and related index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_username"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "username"
    `);

    // Drop first_name and last_name columns
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "first_name"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "last_name"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Add back username, first_name, last_name
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "username" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "first_name" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "last_name" character varying
    `);

    // Migrate name back to first_name (simple approach)
    await queryRunner.query(`
      UPDATE "users" SET "first_name" = "name"
    `);

    // Create username from email
    await queryRunner.query(`
      UPDATE "users" SET "username" = SPLIT_PART(email, '@', 1)
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_users_username" UNIQUE ("username")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_users_username" ON "users" ("username")
    `);

    // Remove phone constraints
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_phone"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_phone"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL
    `);

    // Drop parent_phone
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_users_parent_phone"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "parent_phone"
    `);

    // Drop name column
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "name"
    `);
  }
}
