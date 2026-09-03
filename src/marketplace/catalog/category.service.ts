import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { categoryDepthExceeded, categoryReferenced } from '../common/errors';
import { slugify } from '../common/utils/slugify.util';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { MarketplaceCategory, MarketplaceCourse } from './entities';

/**
 * FR-034 – FR-040. Admin CRUD over the taxonomy — entirely separate from
 * `PublicCategoriesController`/`CategoriesReadService` (T085), which only
 * reads active categories for public browsing. This service is the only
 * writer.
 */
@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(MarketplaceCategory)
    private readonly categories: Repository<MarketplaceCategory>,
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
  ) {}

  public async listAll(): Promise<MarketplaceCategory[]> {
    return this.categories.find({ order: { display_order: 'ASC' } });
  }

  public async create(dto: CreateCategoryDto): Promise<MarketplaceCategory> {
    if (dto.parent_id) {
      await this.assertValidParent(dto.parent_id);
    }
    const category = this.categories.create({
      name_en: dto.name_en,
      name_ar: dto.name_ar,
      slug: slugify(dto.name_en, 'category'),
      description_en: dto.description_en ?? null,
      description_ar: dto.description_ar ?? null,
      icon_key: dto.icon_key ?? null,
      parent_id: dto.parent_id ?? null,
      display_order: dto.display_order ?? 0,
    });
    return this.categories.save(category);
  }

  public async update(id: string, dto: UpdateCategoryDto): Promise<MarketplaceCategory> {
    const category = await this.getOrThrow(id);
    if (dto.parent_id) {
      await this.assertValidParent(dto.parent_id, id);
    }
    Object.assign(category, dto);
    return this.categories.save(category);
  }

  /** FR-039: refused with the referencing course count when any course is assigned; deactivation (`update` with `is_active: false`) is the offered alternative. */
  public async delete(id: string): Promise<void> {
    const category = await this.getOrThrow(id);
    const referencingCourseCount = await this.courses.count({ where: { category_id: category.id } });
    if (referencingCourseCount > 0) {
      throw categoryReferenced(referencingCourseCount);
    }
    await this.categories.remove(category);
  }

  private async getOrThrow(id: string): Promise<MarketplaceCategory> {
    const category = await this.categories.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(biBody('Category not found', 'الفئة غير موجودة'));
    }
    return category;
  }

  /** FR-036: at most two levels — a category whose own `parent_id` is set cannot become a parent itself. */
  private async assertValidParent(parentId: string, selfId?: string): Promise<void> {
    if (parentId === selfId) {
      throw categoryDepthExceeded();
    }
    const parent = await this.categories.findOne({ where: { id: parentId } });
    if (!parent) {
      throw new NotFoundException(biBody('Parent category not found', 'الفئة الأصل غير موجودة'));
    }
    if (parent.parent_id !== null) {
      throw categoryDepthExceeded();
    }
  }
}
