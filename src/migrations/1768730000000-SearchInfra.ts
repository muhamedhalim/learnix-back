import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Search infrastructure:
 *  - trigram GIN indexes on courses (lesson_packages) + subjects for fast ILIKE
 *  - a search_queries log powering "recent" (per user) and "popular" searches
 */
export class SearchInfra1768730000000 implements MigrationInterface {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lesson_packages_title_gin
        ON lesson_packages USING GIN (title gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lesson_packages_title_ar_gin
        ON lesson_packages USING GIN (title_ar gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subjects_name_gin
        ON subjects USING GIN (name gin_trgm_ops);
    `);

    // Search log (created outside the concurrent-index constraints).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS search_queries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        query VARCHAR(200) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_search_queries_query ON search_queries(query);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_search_queries_user_created
        ON search_queries(user_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS search_queries;`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_subjects_name_gin;`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_lesson_packages_title_ar_gin;`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_lesson_packages_title_gin;`);
  }
}
