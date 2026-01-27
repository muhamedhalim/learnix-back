import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateLessonPackagesSchema1767909768104
  implements MigrationInterface
{
  public name = 'UpdateLessonPackagesSchema1767909768104';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Rename is_published to is_active
    // First check if is_published exists to avoid errors if it was already renamed
    const table = await queryRunner.getTable('lesson_packages');
    const isPublishedColumn = table?.findColumnByName('is_published');
    const isActiveColumn = table?.findColumnByName('is_active');

    if (isPublishedColumn && !isActiveColumn) {
      await queryRunner.query(`
        ALTER TABLE "lesson_packages" RENAME COLUMN "is_published" TO "is_active";
      `);
    } else if (!isActiveColumn) {
      // If neither exists (unlikely given InitialSchema), add is_active
      await queryRunner.query(`
        ALTER TABLE "lesson_packages" ADD COLUMN "is_active" boolean DEFAULT true;
      `);
    }

    // Update default value for is_active to true (entity definition)
    await queryRunner.query(`
      ALTER TABLE "lesson_packages" ALTER COLUMN "is_active" SET DEFAULT true;
    `);

    // Add index for is_active if it doesn't exist
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_is_active" ON "lesson_packages" ("is_active");
    `);

    // 2. Add thumbnail column
    await queryRunner.query(`
      ALTER TABLE "lesson_packages" ADD COLUMN IF NOT EXISTS "thumbnail" varchar(500);
    `);

    // 3. Add index for price (defined in entity)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_price" ON "lesson_packages" ("price");
    `);

    // 4. Add index for created_at (defined in entity)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_created_at" ON "lesson_packages" ("created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indices
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_lesson_packages_created_at";
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_lesson_packages_price";
    `);

    // Drop thumbnail
    await queryRunner.query(`
      ALTER TABLE "lesson_packages" DROP COLUMN IF EXISTS "thumbnail";
    `);

    // Revert is_active to is_published
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_lesson_packages_is_active";
    `);

    await queryRunner.query(`
      ALTER TABLE "lesson_packages" ALTER COLUMN "is_active" SET DEFAULT false;
    `);

    await queryRunner.query(`
      ALTER TABLE "lesson_packages" RENAME COLUMN "is_active" TO "is_published";
    `);
  }
}
