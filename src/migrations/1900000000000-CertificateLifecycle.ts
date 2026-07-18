import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Certificate lifecycle upgrade:
 *
 * 1. `certificate_templates.status` (draft | published | archived).
 *    Existing templates are backfilled to PUBLISHED — they were live before
 *    this migration (auto-issue used them), so demoting them to draft would
 *    silently break course-completion issuance.
 * 2. `certificates.is_public`      — student-controlled gallery visibility
 *    (defaults to false: nothing becomes public retroactively).
 * 3. `certificates.template_snapshot` — frozen design at issue time. Legacy
 *    rows stay NULL and keep rendering from their live template.
 * 4. `certificates.revoked_at` / `revoke_reason` — revocation metadata.
 * 5. Gallery index on (is_public, status, issued_at).
 */
export class CertificateLifecycle1900000000000 implements MigrationInterface {
  name = 'CertificateLifecycle1900000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "certificate_template_status_enum" AS ENUM ('draft', 'published', 'archived');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "certificate_templates"
      ADD COLUMN IF NOT EXISTS "status" "certificate_template_status_enum" NOT NULL DEFAULT 'draft'
    `);
    // Pre-existing templates were already in active use.
    await queryRunner.query(`UPDATE "certificate_templates" SET "status" = 'published'`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_certificate_templates_status"
      ON "certificate_templates" ("status")
    `);

    await queryRunner.query(`
      ALTER TABLE "certificates"
      ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "template_snapshot" jsonb,
      ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "revoke_reason" text
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_certificates_public_gallery"
      ON "certificates" ("is_public", "status", "issued_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_certificates_public_gallery"`);
    await queryRunner.query(`
      ALTER TABLE "certificates"
      DROP COLUMN IF EXISTS "revoke_reason",
      DROP COLUMN IF EXISTS "revoked_at",
      DROP COLUMN IF EXISTS "template_snapshot",
      DROP COLUMN IF EXISTS "is_public"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_certificate_templates_status"`);
    await queryRunner.query(`ALTER TABLE "certificate_templates" DROP COLUMN IF EXISTS "status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "certificate_template_status_enum"`);
  }
}
