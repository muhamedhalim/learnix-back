import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Speeds the call-centre/admin student directory's case-insensitive name
 * search. The pg_trgm extension is enabled by an earlier migration.
 */
export class AddStudentDirectorySearchIndexes2063000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_users_first_name_trgm" ON "users" USING GIN ("first_name" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_users_last_name_trgm" ON "users" USING GIN ("last_name" gin_trgm_ops)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_last_name_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_first_name_trgm"');
  }
}
