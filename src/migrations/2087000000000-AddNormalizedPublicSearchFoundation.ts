import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives public catalogue search a single, indexed representation of the
 * fields it already searches. The representation folds the Arabic variants
 * handled by `normalizeArabicQuery`, normalizes English case, and collapses
 * whitespace. It deliberately does not introduce unaccent or full-text
 * search: neither is used by the current public-search queries.
 *
 * Generated columns are populated by PostgreSQL for both existing and future
 * rows, avoiding an application-level backfill. The ALTER TABLE operations
 * can take a short schema lock; the matching GIN indexes are built
 * concurrently so their build does not block normal reads and writes.
 */
export class AddNormalizedPublicSearchFoundation2087000000000 implements MigrationInterface {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.learnix_normalize_search_text(input text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      STRICT
      AS $$
        SELECT btrim(
          regexp_replace(
            translate(
              regexp_replace(lower(input), '[ً-ْٰـ]', '', 'g'),
              'آأإٱىة',
              'اااايه'
            ),
            '\\s+', ' ', 'g'
          )
        )
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "lesson_packages"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (
        public.learnix_normalize_search_text(
          coalesce("title", '') || ' ' || coalesce("title_ar", '') || ' ' || coalesce("description", '')
        )
      ) STORED;
    `);
    await queryRunner.query(`
      ALTER TABLE "lessons"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (public.learnix_normalize_search_text(coalesce("title", ''))) STORED;
    `);
    await queryRunner.query(`
      ALTER TABLE "books"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (
        public.learnix_normalize_search_text(coalesce("title", '') || ' ' || coalesce("title_ar", ''))
      ) STORED;
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (public.learnix_normalize_search_text(coalesce("name", ''))) STORED;
    `);
    await queryRunner.query(`
      ALTER TABLE "subjects"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (public.learnix_normalize_search_text(coalesce("name", ''))) STORED;
    `);
    await queryRunner.query(`
      ALTER TABLE "course_chapters"
      ADD COLUMN IF NOT EXISTS "search_text" text
      GENERATED ALWAYS AS (
        public.learnix_normalize_search_text(coalesce("title", '') || ' ' || coalesce("title_ar", ''))
      ) STORED;
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lesson_packages_search_text_trgm"
      ON "lesson_packages" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_lessons_search_text_trgm"
      ON "lessons" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_books_search_text_trgm"
      ON "books" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_public_teacher_search_text_trgm"
      ON "users" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL
        AND "role" = 'teacher'
        AND "is_active" = true
        AND "status" = 'approved';
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_support_search_text_trgm"
      ON "users" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL
        AND "role" IN ('student', 'teacher');
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_subjects_search_text_trgm"
      ON "subjects" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_course_chapters_search_text_trgm"
      ON "course_chapters" USING GIN ("search_text" gin_trgm_ops)
      WHERE "deleted_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_course_chapters_search_text_trgm";`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_subjects_search_text_trgm";`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_users_public_teacher_search_text_trgm";`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_users_support_search_text_trgm";`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_books_search_text_trgm";`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_lessons_search_text_trgm";`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_lesson_packages_search_text_trgm";`,
    );

    await queryRunner.query(`ALTER TABLE "course_chapters" DROP COLUMN IF EXISTS "search_text";`);
    await queryRunner.query(`ALTER TABLE "subjects" DROP COLUMN IF EXISTS "search_text";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "search_text";`);
    await queryRunner.query(`ALTER TABLE "books" DROP COLUMN IF EXISTS "search_text";`);
    await queryRunner.query(`ALTER TABLE "lessons" DROP COLUMN IF EXISTS "search_text";`);
    await queryRunner.query(`ALTER TABLE "lesson_packages" DROP COLUMN IF EXISTS "search_text";`);

    await queryRunner.query(`DROP FUNCTION IF EXISTS public.learnix_normalize_search_text(text);`);
  }
}
