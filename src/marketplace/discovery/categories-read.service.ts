import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MarketplaceCategory, MarketplaceCourse } from '../catalog/entities';
import { MarketplaceCourseStatus } from '../common/enums';

export interface PublicCategory {
  id: string;
  parent_id: string | null;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  slug: string;
  icon_key: string | null;
  display_order: number;
  published_course_count: number;
}

/**
 * FR-034 – FR-040, FR-085. Read-only: taxonomy plus a published-course
 * count per category, computed live against the real (if still largely
 * empty) `marketplace_courses` table — same pattern as
 * `PublicInstructorProfileService`'s aggregates, not a stub. Category
 * management (create/update/deactivate/delete) is `CategoryService`'s job
 * (T057, not yet built) — this service never writes.
 */
@Injectable()
export class CategoriesReadService {
  constructor(
    @InjectRepository(MarketplaceCategory)
    private readonly categories: Repository<MarketplaceCategory>,
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
  ) {}

  public async listActive(): Promise<PublicCategory[]> {
    const rows = await this.categories.find({
      where: { is_active: true },
      order: { display_order: 'ASC' },
    });
    if (rows.length === 0) return [];

    const counts = await this.courses
      .createQueryBuilder('c')
      .select('c.category_id', 'category_id')
      .addSelect('COUNT(*)', 'count')
      .where('c.status = :status', { status: MarketplaceCourseStatus.PUBLISHED })
      .andWhere('c.removed_at IS NULL')
      .groupBy('c.category_id')
      .getRawMany<{ category_id: string; count: string }>();
    const countByCategory = new Map(counts.map((row) => [row.category_id, Number(row.count)]));

    return rows.map((category) => ({
      id: category.id,
      parent_id: category.parent_id,
      name_en: category.name_en,
      name_ar: category.name_ar,
      description_en: category.description_en,
      description_ar: category.description_ar,
      slug: category.slug,
      icon_key: category.icon_key,
      display_order: category.display_order,
      published_course_count: countByCategory.get(category.id) ?? 0,
    }));
  }
}

