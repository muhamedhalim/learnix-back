import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * i18n foundation: per-user preferred language (AR/EN).
 *
 * Additive and backward compatible — the column is nullable with no default,
 * so every existing row keeps a NULL value which the localized-content layer
 * resolves to English. Reuses the same two-value language enum that already
 * drives guardian-message localization; TypeORM maps it to a dedicated
 * `users_preferred_language_enum` Postgres type.
 */
export class AddUserPreferredLanguage1810000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_preferred_language_enum') THEN
          CREATE TYPE "users_preferred_language_enum" AS ENUM ('ar', 'en');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "preferred_language" "users_preferred_language_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "preferred_language"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_preferred_language_enum"`);
  }
}
