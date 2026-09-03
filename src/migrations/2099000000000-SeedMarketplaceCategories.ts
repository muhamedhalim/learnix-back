import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seventh marketplace migration (plan.md §3 migration 7 of 8). Seeds the
 * eleven categories FR-037 requires at minimum, as top-level entries — the
 * requirement lists a flat set; it does not mandate a parent/child grouping,
 * so none is invented. Idempotent: `ON CONFLICT ("slug") DO NOTHING` makes a
 * re-run a no-op rather than a duplicate or an error.
 */
export class SeedMarketplaceCategories2099000000000 implements MigrationInterface {
  public name = 'SeedMarketplaceCategories2099000000000';

  private static readonly CATEGORIES: Array<{
    slug: string;
    nameEn: string;
    nameAr: string;
    order: number;
  }> = [
    { slug: 'programming', nameEn: 'Programming', nameAr: 'البرمجة', order: 1 },
    { slug: 'web-development', nameEn: 'Web Development', nameAr: 'تطوير الويب', order: 2 },
    {
      slug: 'mobile-development',
      nameEn: 'Mobile Development',
      nameAr: 'تطوير تطبيقات الجوال',
      order: 3,
    },
    {
      slug: 'artificial-intelligence',
      nameEn: 'Artificial Intelligence',
      nameAr: 'الذكاء الاصطناعي',
      order: 4,
    },
    { slug: 'data-science', nameEn: 'Data Science', nameAr: 'علم البيانات', order: 5 },
    { slug: 'cybersecurity', nameEn: 'Cybersecurity', nameAr: 'الأمن السيبراني', order: 6 },
    { slug: 'ui-ux', nameEn: 'UI/UX', nameAr: 'تصميم واجهات وتجربة المستخدم', order: 7 },
    { slug: 'graphic-design', nameEn: 'Graphic Design', nameAr: 'التصميم الجرافيكي', order: 8 },
    { slug: 'digital-marketing', nameEn: 'Digital Marketing', nameAr: 'التسويق الرقمي', order: 9 },
    { slug: 'business', nameEn: 'Business', nameAr: 'الأعمال', order: 10 },
    {
      slug: 'other-professional-skills',
      nameEn: 'Other Professional Skills',
      nameAr: 'مهارات مهنية أخرى',
      order: 11,
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const category of SeedMarketplaceCategories2099000000000.CATEGORIES) {
      await queryRunner.query(
        `
        INSERT INTO "marketplace_categories" ("name_en", "name_ar", "slug", "display_order")
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ("slug") DO NOTHING
        `,
        [category.nameEn, category.nameAr, category.slug, category.order],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const slugs = SeedMarketplaceCategories2099000000000.CATEGORIES.map((c) => c.slug);
    await queryRunner.query(
      `DELETE FROM "marketplace_categories" WHERE "slug" = ANY($1) AND NOT EXISTS (
         SELECT 1 FROM "marketplace_courses" WHERE "marketplace_courses"."category_id" = "marketplace_categories"."id"
       )`,
      [slugs],
    );
  }
}
