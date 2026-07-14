import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves refresh-token verification to the per-device session row. Existing
 * refresh credentials cannot be migrated safely because only bcrypt hashes are
 * stored, so this migration deliberately revokes them and requires one login.
 */
export class HardenUserSessions1850000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "user_sessions"`);
    await queryRunner.query(`
      ALTER TABLE "user_sessions"
      ADD COLUMN IF NOT EXISTS "refresh_token_hash" text NOT NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_sessions_refresh_token_id"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_user_sessions_refresh_token_id"
      ON "user_sessions" ("refresh_token_id")
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_refresh_token_id"`);
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "refresh_token",
      DROP COLUMN IF EXISTS "refresh_token_id",
      DROP COLUMN IF EXISTS "refresh_token_expires_at"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "refresh_token" text,
      ADD COLUMN IF NOT EXISTS "refresh_token_id" varchar(64),
      ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_refresh_token_id"
      ON "users" ("refresh_token_id")
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_sessions_refresh_token_id"`);
    await queryRunner.query(`
      CREATE INDEX "IDX_user_sessions_refresh_token_id"
      ON "user_sessions" ("refresh_token_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "user_sessions"
      DROP COLUMN IF EXISTS "refresh_token_hash"
    `);
  }
}
