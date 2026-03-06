import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUploadedFilesTable1768626000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create uploaded_files table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "uploaded_files" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "filename" VARCHAR(255) NOT NULL UNIQUE,
        "original_filename" VARCHAR(255) NOT NULL,
        "folder" VARCHAR(50) NOT NULL,
        "mime_type" VARCHAR(100) NOT NULL,
        "size" BIGINT NOT NULL,
        "uploader_id" UUID,
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "FK_uploaded_files_uploader" FOREIGN KEY ("uploader_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_uploaded_files_filename"
      ON "uploaded_files" ("filename")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_uploaded_files_uploader_id"
      ON "uploaded_files" ("uploader_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_uploaded_files_created_at"
      ON "uploaded_files" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_uploaded_files_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_uploaded_files_uploader_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_uploaded_files_filename"`,
    );

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS "uploaded_files"`);
  }
}
