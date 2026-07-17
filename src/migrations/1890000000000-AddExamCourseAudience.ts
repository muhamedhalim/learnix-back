import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds an explicit course audience for private exams without changing legacy rows. */
export class AddExamCourseAudience1890000000000 implements MigrationInterface {
  public readonly name = 'AddExamCourseAudience1890000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "exams" ADD COLUMN "package_id" uuid`);
    await queryRunner.query(`CREATE INDEX "IDX_exams_package_id" ON "exams" ("package_id")`);
    await queryRunner.query(
      `ALTER TABLE "exams" ADD CONSTRAINT "FK_exams_package_id" FOREIGN KEY ("package_id") REFERENCES "lesson_packages"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT "FK_exams_package_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_exams_package_id"`);
    await queryRunner.query(`ALTER TABLE "exams" DROP COLUMN "package_id"`);
  }
}
