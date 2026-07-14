import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OptimizeUploadedFileListing1860000000000 implements MigrationInterface {
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_uploaded_files_uploader_created_active"
      ON "uploaded_files" ("uploader_id", "created_at", "id")
      WHERE "deleted_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_uploaded_files_uploader_folder_created_active"
      ON "uploaded_files" ("uploader_id", "folder", "created_at", "id")
      WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_uploaded_files_uploader_folder_created_active"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_uploaded_files_uploader_created_active"`,
    );
  }
}
