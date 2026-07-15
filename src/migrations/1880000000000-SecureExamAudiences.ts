import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds explicit public/private classification used by exam and practice policies. */
export class SecureExamAudiences1880000000000 implements MigrationInterface {
  public readonly name = 'SecureExamAudiences1880000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "exams" ADD COLUMN "is_public" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_exams_is_public" ON "exams" ("is_public")`);
    await queryRunner.query(
      `ALTER TABLE "questions" ADD COLUMN "is_public" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_questions_is_public" ON "questions" ("is_public")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_questions_is_public"`);
    await queryRunner.query(`ALTER TABLE "questions" DROP COLUMN "is_public"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_exams_is_public"`);
    await queryRunner.query(`ALTER TABLE "exams" DROP COLUMN "is_public"`);
  }
}
