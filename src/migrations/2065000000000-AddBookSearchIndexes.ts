import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookSearchIndexes2065000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_books_title_trgm" ON "books" USING GIN ("title" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_books_title_ar_trgm" ON "books" USING GIN ("title_ar" gin_trgm_ops)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_books_title_ar_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_books_title_trgm"');
  }
}
