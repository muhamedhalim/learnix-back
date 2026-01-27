import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateExamAttemptsNullableSubmitted1768618000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Make submitted_at nullable to support IN_PROGRESS attempts
    await queryRunner.query(`
      ALTER TABLE exam_attempts
      ALTER COLUMN submitted_at DROP NOT NULL;
    `);

    // Update existing attempts to have SUBMITTED status if submitted_at is not null
    await queryRunner.query(`
      UPDATE exam_attempts
      SET status = 'SUBMITTED'
      WHERE submitted_at IS NOT NULL
        AND status = 'IN_PROGRESS';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Set default value for null submitted_at before making it NOT NULL
    await queryRunner.query(`
      UPDATE exam_attempts
      SET submitted_at = created_at
      WHERE submitted_at IS NULL;
    `);

    // Revert submitted_at to NOT NULL
    await queryRunner.query(`
      ALTER TABLE exam_attempts
      ALTER COLUMN submitted_at SET NOT NULL;
    `);
  }
}
