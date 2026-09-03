import { MarketplaceCourseStatus } from '../common/enums';
import { CategoriesReadService } from './categories-read.service';
import type { MarketplaceCategory } from '../catalog/entities';

function buildCategory(overrides: Partial<MarketplaceCategory> = {}): MarketplaceCategory {
  return {
    id: 'cat-1',
    parent_id: null,
    name_en: 'Programming',
    name_ar: 'البرمجة',
    description_en: null,
    description_ar: null,
    slug: 'programming',
    icon_key: null,
    display_order: 1,
    is_active: true,
    ...overrides,
  } as unknown as MarketplaceCategory;
}

function buildService(categoryRows: MarketplaceCategory[], countRows: { category_id: string; count: string }[]) {
  const categories = {
    find: jest.fn().mockResolvedValue(categoryRows),
  };
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(countRows),
  };
  const courses = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const service = new CategoriesReadService(categories as never, courses as never);
  return { service, categories, courses, qb };
}

describe('CategoriesReadService', () => {
  it('returns active categories ordered by display_order, with a zero course count when there are no published courses yet', async () => {
    const { service, categories } = buildService([buildCategory()], []);
    const result = await service.listActive();

    expect(categories.find).toHaveBeenCalledWith({
      where: { is_active: true },
      order: { display_order: 'ASC' },
    });
    expect(result).toEqual([expect.objectContaining({ id: 'cat-1', slug: 'programming', published_course_count: 0 })]);
  });

  it('attaches the real published-course count per category, never a fabricated figure', async () => {
    const { service, qb } = buildService(
      [buildCategory({ id: 'cat-1' }), buildCategory({ id: 'cat-2', slug: 'design' })],
      [{ category_id: 'cat-1', count: '3' }],
    );
    const result = await service.listActive();

    expect(qb.where).toHaveBeenCalledWith('c.status = :status', { status: MarketplaceCourseStatus.PUBLISHED });
    expect(qb.andWhere).toHaveBeenCalledWith('c.removed_at IS NULL');
    expect(result.find((c) => c.id === 'cat-1')?.published_course_count).toBe(3);
    expect(result.find((c) => c.id === 'cat-2')?.published_course_count).toBe(0);
  });

  it('short-circuits the count query when there are no active categories', async () => {
    const { service, courses } = buildService([], []);
    const result = await service.listActive();
    expect(result).toEqual([]);
    expect(courses.createQueryBuilder).not.toHaveBeenCalled();
  });
});
