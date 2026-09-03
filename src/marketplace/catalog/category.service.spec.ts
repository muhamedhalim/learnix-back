import type { MarketplaceCategory } from './entities';
import { CategoryService } from './category.service';

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

function buildService(categoryRows: Record<string, MarketplaceCategory> = {}, referencingCourseCount = 0) {
  const categories = {
    find: jest.fn().mockResolvedValue(Object.values(categoryRows)),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => categoryRows[where.id] ?? null),
    create: jest.fn((data: Partial<MarketplaceCategory>) => data as MarketplaceCategory),
    save: jest.fn(async (entity: MarketplaceCategory) => ({ id: 'cat-new', ...entity })),
    remove: jest.fn(async (entity: MarketplaceCategory) => entity),
  };
  const courses = {
    count: jest.fn().mockResolvedValue(referencingCourseCount),
  };
  const service = new CategoryService(categories as never, courses as never);
  return { service, categories, courses };
}

describe('CategoryService', () => {
  describe('create', () => {
    it('creates a top-level category with a generated slug — the column is NOT NULL and mocks do not enforce that', async () => {
      const { service, categories } = buildService();
      const result = await service.create({ name_en: 'Design', name_ar: 'التصميم' });
      expect(categories.save).toHaveBeenCalled();
      expect(result.name_en).toBe('Design');
      expect(result.slug).toMatch(/^design-[0-9a-f]{6}$/);
    });

    it('creates a sub-category under a top-level parent', async () => {
      const parent = buildCategory({ id: 'parent-1', parent_id: null });
      const { service } = buildService({ 'parent-1': parent });
      await expect(
        service.create({ name_en: 'Web Development', name_ar: 'تطوير الويب', parent_id: 'parent-1' }),
      ).resolves.toBeDefined();
    });

    it('refuses a third level — a sub-category cannot itself be a parent (FR-036)', async () => {
      const grandparent = buildCategory({ id: 'gp-1', parent_id: null });
      const parent = buildCategory({ id: 'parent-1', parent_id: 'gp-1' });
      const { service } = buildService({ 'gp-1': grandparent, 'parent-1': parent });
      await expect(
        service.create({ name_en: 'X', name_ar: 'س', parent_id: 'parent-1' }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CATEGORY_DEPTH_EXCEEDED' }) });
    });

    it('refuses a nonexistent parent', async () => {
      const { service } = buildService({});
      await expect(service.create({ name_en: 'X', name_ar: 'س', parent_id: 'missing' })).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('applies a partial update, including reordering via display_order', async () => {
      const category = buildCategory({ id: 'cat-1', display_order: 1 });
      const { service, categories } = buildService({ 'cat-1': category });
      const result = await service.update('cat-1', { display_order: 5 });
      expect(result.display_order).toBe(5);
      expect(categories.save).toHaveBeenCalled();
    });

    it('deactivates a category (FR-040)', async () => {
      const category = buildCategory({ id: 'cat-1', is_active: true });
      const { service } = buildService({ 'cat-1': category });
      const result = await service.update('cat-1', { is_active: false });
      expect(result.is_active).toBe(false);
    });

    it('refuses reparenting to itself', async () => {
      const category = buildCategory({ id: 'cat-1' });
      const { service } = buildService({ 'cat-1': category });
      await expect(service.update('cat-1', { parent_id: 'cat-1' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CATEGORY_DEPTH_EXCEEDED' }),
      });
    });
  });

  describe('delete', () => {
    it('deletes a category with no referencing courses', async () => {
      const category = buildCategory({ id: 'cat-1' });
      const { service, categories } = buildService({ 'cat-1': category }, 0);
      await service.delete('cat-1');
      expect(categories.remove).toHaveBeenCalledWith(category);
    });

    it('refuses deletion with the referencing course count (FR-039)', async () => {
      const category = buildCategory({ id: 'cat-1' });
      const { service, categories } = buildService({ 'cat-1': category }, 4);
      await expect(service.delete('cat-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CATEGORY_REFERENCED', courseCount: 4 }),
      });
      expect(categories.remove).not.toHaveBeenCalled();
    });

    it('refuses deletion of a nonexistent category', async () => {
      const { service } = buildService({});
      await expect(service.delete('missing')).rejects.toThrow();
    });
  });

  describe('listAll', () => {
    it('returns every category ordered by display_order, including inactive ones', async () => {
      const a = buildCategory({ id: 'a', display_order: 2 });
      const b = buildCategory({ id: 'b', display_order: 1, is_active: false });
      const { service, categories } = buildService({ a, b });
      await service.listAll();
      expect(categories.find).toHaveBeenCalledWith({ order: { display_order: 'ASC' } });
    });
  });
});
