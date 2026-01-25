import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add full-text search indexes for better search performance
 *
 * Creates GIN indexes on:
 * - users.name (for students/teachers search)
 * - lessons.title + title_ar (for lessons search)
 * - exams.title + title_ar (for exams search)
 *
 * GIN indexes support fast ILIKE queries and full-text search operations
 */
export class AddSearchIndexes1768612000000 implements MigrationInterface {
  // Disable transaction wrapping - required for CONCURRENTLY operations
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pg_trgm extension for trigram-based text search
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    `);

    // Add GIN index on users.name for student/teacher search
    // Supports ILIKE queries like: WHERE name ILIKE '%search%'
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_gin
        ON users USING GIN (name gin_trgm_ops);
    `);

    // Add GIN index on users.email for search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_gin
        ON users USING GIN (email gin_trgm_ops);
    `);

    // Add GIN index on lessons.title for English search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lessons_title_gin
        ON lessons USING GIN (title gin_trgm_ops);
    `);

    // Add GIN index on lessons.title_ar for Arabic search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lessons_title_ar_gin
        ON lessons USING GIN (title_ar gin_trgm_ops);
    `);

    // Add GIN index on exams.title for English search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exams_title_gin
        ON exams USING GIN (title gin_trgm_ops);
    `);

    // Add GIN index on exams.title_ar for Arabic search
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exams_title_ar_gin
        ON exams USING GIN (title_ar gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop search indexes in reverse order
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_exams_title_ar_gin;
    `);

    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_exams_title_gin;
    `);

    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_lessons_title_ar_gin;
    `);

    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_lessons_title_gin;
    `);

    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_users_email_gin;
    `);

    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS idx_users_name_gin;
    `);
  }
}
