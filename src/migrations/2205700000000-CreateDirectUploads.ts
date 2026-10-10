import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tracks browser-to-S3 direct uploads (presigned single PUT or multipart). The row is what
 * authorises `complete`/`abort`: only the creating user may finish a session, and the server
 * re-verifies size, type and content against what was declared here before the object is trusted.
 */
export class CreateDirectUploads2205700000000 implements MigrationInterface {
  public name = 'CreateDirectUploads2205700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "direct_uploads" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "purpose" varchar(40) NOT NULL,
        "bucket" varchar(255) NOT NULL,
        "object_key" varchar(500) NOT NULL,
        "original_name" varchar(255) NOT NULL,
        "content_type" varchar(150) NOT NULL,
        "declared_size" bigint NOT NULL,
        "mode" varchar(12) NOT NULL,
        "multipart_upload_id" varchar(1024) NULL,
        "part_size" integer NULL,
        "status" varchar(12) NOT NULL DEFAULT 'initiated',
        "failure_reason" varchar(255) NULL,
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_direct_uploads_mode" CHECK ("mode" IN ('single', 'multipart')),
        CONSTRAINT "CHK_direct_uploads_status" CHECK ("status" IN ('initiated', 'completed', 'aborted', 'failed')),
        CONSTRAINT "CHK_direct_uploads_size" CHECK ("declared_size" > 0)
      );
      CREATE INDEX IF NOT EXISTS "IDX_direct_uploads_user_status" ON "direct_uploads" ("user_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_direct_uploads_open_expiry" ON "direct_uploads" ("expires_at")
        WHERE "status" = 'initiated';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "direct_uploads";`);
  }
}
