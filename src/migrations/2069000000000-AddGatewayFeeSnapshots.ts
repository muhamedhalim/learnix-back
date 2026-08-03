import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gateway fees are platform-paid operating expenses. Snapshotting the rate and
 * amount on each order makes settlement and revenue reporting deterministic
 * even when the configured provider rate changes later.
 */
export class AddGatewayFeeSnapshots2069000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS gateway_fee_bps integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gateway_fee_minor bigint NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE orders DROP COLUMN IF EXISTS gateway_fee_minor`);
    await queryRunner.query(`ALTER TABLE orders DROP COLUMN IF EXISTS gateway_fee_bps`);
  }
}
