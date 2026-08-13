import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds complaint idempotency and search indexes without splitting the aggregate. */
export class HardenComplaintsWorkflow2088000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await queryRunner.query('ALTER TABLE "complaints" ADD COLUMN "request_id" uuid');
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_complaints_complainant_request_id"
      ON "complaints" ("complainant_id", "request_id")
      WHERE "request_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_complaints_ticket_number_trgm"
      ON "complaints" USING gin ("ticket_number" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_complaints_subject_trgm"
      ON "complaints" USING gin ("subject" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_complaints_description_trgm"
      ON "complaints" USING gin ("description" gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_complaints_description_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_complaints_subject_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_complaints_ticket_number_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_complaints_complainant_request_id"');
    await queryRunner.query('ALTER TABLE "complaints" DROP COLUMN "request_id"');
  }
}
