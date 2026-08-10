import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Health probes intentionally emit `disabled` for capabilities that are not
 * configured. The original observability constraint omitted that valid domain
 * status, causing every collection cycle to fail instead of recording it.
 */
export class AllowDisabledHealthMetricStatus2074000000000 implements MigrationInterface {
  public name = 'AllowDisabledHealthMetricStatus2074000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "health_metrics" DROP CONSTRAINT IF EXISTS "CHK_health_metrics_status"`);
    await queryRunner.query(`
      ALTER TABLE "health_metrics"
      ADD CONSTRAINT "CHK_health_metrics_status"
      CHECK ("status" IN ('healthy','warning','degraded','down','misconfigured','unknown','disabled'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "health_metrics" DROP CONSTRAINT IF EXISTS "CHK_health_metrics_status"`);
    await queryRunner.query(`
      ALTER TABLE "health_metrics"
      ADD CONSTRAINT "CHK_health_metrics_status"
      CHECK ("status" IN ('healthy','warning','degraded','down','misconfigured','unknown'))
    `);
  }
}
