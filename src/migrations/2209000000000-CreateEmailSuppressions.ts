import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F-34: SES bounces and complaints were only logged. This table stores permanently bounced and
 * complaining addresses so the mail funnel can stop sending to them (sender reputation, SES production
 * access). Additive and idempotent; `down` drops only this new table.
 */
export class CreateEmailSuppressions2209000000000 implements MigrationInterface {
  public name = 'CreateEmailSuppressions2209000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "email_suppressions" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "email" character varying(320) NOT NULL,
         "reason" character varying(16) NOT NULL,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "UQ_email_suppressions_email" UNIQUE ("email"),
         CONSTRAINT "PK_email_suppressions_id" PRIMARY KEY ("id")
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "email_suppressions"`);
  }
}
