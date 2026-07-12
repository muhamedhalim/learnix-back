import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, In, IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { MediaService } from '../media/media.service';
import { User } from '../users/entities/user.entity';
import {
  AddLessonsDto,
  CreateChapterDto,
  CreatePackageDto,
  PackageFilterDto,
  PackageSortBy,
  RemoveLessonsDto,
  ReorderCurriculumDto,
  UpdateChapterDto,
  UpdatePackageDto,
} from './dto';
import { CourseChapter } from './entities/course-chapter.entity';
import { CourseStatus } from './entities/course-status.enum';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';

export interface PackageWithDetails {
  id: string;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  // Nullable: the joined teacher (User) row is silently excluded by TypeORM
  // when it has been soft-deleted (see mapToPackageWithDetails for why).
  teacher: {
    id: string;
    name: string;
    email: string;
    profile_picture_url: string | null;
  } | null;
  price: number;
  original_price: number | null;
  savings: number | null;
  is_active: boolean;
  status: CourseStatus;
  featured: boolean;
  category: string | null;
  tags: string[] | null;
  estimated_duration: number | null;
  published_at: Date | null;
  scheduled_publish_at: Date | null;
  thumbnail: string | null;
  /** Public URL for `thumbnail`, always routed through the media proxy — never a raw storage URL. */
  thumbnail_url: string | null;
  lessons_count: number;
  lessons: Array<{
    id: string;
    title: string;
    title_ar: string;
    price: number;
    duration: number | null;
    order_index: number;
    chapter_id: string | null;
  }>;
  created_at: Date;
  updated_at: Date;
}

export interface PackageStats {
  total_purchases: number;
  total_revenue: number;
  average_rating: number;
}

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @InjectRepository(LessonPackageItem)
    private readonly packageItemsRepository: Repository<LessonPackageItem>,
    @InjectRepository(CourseChapter)
    private readonly chaptersRepository: Repository<CourseChapter>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly media: MediaService,
  ) {}

  /**
   * Create a new lesson package
   */
  public async create(teacherId: string, dto: CreatePackageDto): Promise<PackageWithDetails> {
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new NotFoundException(biBody('Teacher not found', 'المعلم غير موجود'));
    }

    const pkg = this.packagesRepository.create(
      Object.assign({}, dto, {
        teacher_id: teacherId,
        // Course can be single-language: fall back to `title` for `title_ar`.
        title_ar: dto.title_ar ?? dto.title,
        is_active: true,
        original_price: null,
      }),
    );

    const savedPackage = await this.packagesRepository.save(pkg);
    return await this.findOne(savedPackage.id);
  }

  /**
   * Find all packages with filtering and pagination
   */
  public async findAll(filter: PackageFilterDto): Promise<PaginatedResponse<PackageWithDetails>> {
    const {
      search,
      teacher_id: teacherId,
      minPrice,
      maxPrice,
      is_active: isActive,
      status,
      sortBy = PackageSortBy.CREATED_AT,
      order = 'desc',
      page = 1,
      limit = 20,
    } = filter;

    const queryBuilder = this.packagesRepository
      .createQueryBuilder('package')
      .leftJoinAndSelect('package.teacher', 'teacher')
      .leftJoinAndSelect('package.items', 'items')
      .leftJoinAndSelect('items.lesson', 'lesson')
      .where('package.deleted_at IS NULL');

    if (search !== undefined && search !== '') {
      queryBuilder.andWhere('(package.title ILIKE :search OR package.title_ar ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (teacherId !== undefined && teacherId !== '') {
      queryBuilder.andWhere('package.teacher_id = :teacherId', { teacherId });
    }

    if (minPrice !== undefined) {
      queryBuilder.andWhere('package.price >= :minPrice', { minPrice });
    }

    if (maxPrice !== undefined) {
      queryBuilder.andWhere('package.price <= :maxPrice', { maxPrice });
    }

    if (isActive !== undefined) {
      queryBuilder.andWhere('package.is_active = :isActive', { isActive });
    }

    if (status !== undefined) {
      queryBuilder.andWhere('package.status = :status', { status });
    }

    const sortColumn =
      sortBy === PackageSortBy.LESSONS_COUNT
        ? '(SELECT COUNT(*) FROM lesson_package_items WHERE package_id = package.id)'
        : `package.${sortBy}`;

    queryBuilder.orderBy(sortColumn, order.toUpperCase() as 'ASC' | 'DESC');

    const total = await queryBuilder.getCount();
    const skip = (page - 1) * limit;

    const packages = await queryBuilder.skip(skip).take(limit).getMany();

    const data = packages.map((pkg) => this.mapToPackageWithDetails(pkg));

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data, meta };
  }

  /**
   * Find packages by teacher
   */
  public async findByTeacher(
    teacherId: string,
    filter: Omit<PackageFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PackageWithDetails>> {
    return await this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Find a single package by ID
   */
  public async findOne(id: string): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository
      .createQueryBuilder('package')
      .leftJoinAndSelect('package.teacher', 'teacher')
      .leftJoinAndSelect('package.items', 'items')
      .leftJoinAndSelect('items.lesson', 'lesson')
      .where('package.id = :id', { id })
      .andWhere('package.deleted_at IS NULL')
      .orderBy('items.order_index', 'ASC')
      .getOne();

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${id} not found`, `الباقة بالمعرّف ${id} غير موجودة`),
      );
    }

    return this.mapToPackageWithDetails(pkg);
  }

  /**
   * Update a package (ownership check)
   */
  public async update(
    packageId: string,
    teacherId: string,
    dto: UpdatePackageDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only update your own packages', 'يمكنك تحديث باقاتك الخاصة فقط'),
      );
    }

    Object.assign(pkg, dto);
    await this.packagesRepository.save(pkg);

    return await this.findOne(packageId);
  }

  /**
   * Delete a package (ownership check)
   */
  public async delete(packageId: string, teacherId: string): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only delete your own packages', 'يمكنك حذف باقاتك الخاصة فقط'),
      );
    }

    await this.packagesRepository.softDelete(packageId);
  }

  /**
   * Admin delete (no ownership check)
   */
  public async adminDelete(packageId: string): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    await this.packagesRepository.softDelete(packageId);
  }

  /**
   * Find teacher's own packages
   */
  public async findMyPackages(
    teacherId: string,
    filter: Omit<PackageFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PackageWithDetails>> {
    return await this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Add lessons to a package (with transaction)
   */
  public async addLessons(
    packageId: string,
    teacherId: string,
    dto: AddLessonsDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
      relations: ['items'],
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only modify your own packages', 'يمكنك تعديل باقاتك الخاصة فقط'),
      );
    }

    const lessonIds = dto.lessons.map((l) => l.lessonId);
    await this.validateLessonsOwnership(lessonIds, teacherId);

    const existingLessonIds = new Set(pkg.items.map((item) => item.lesson_id));
    const duplicates = lessonIds.filter((id) => existingLessonIds.has(id));
    if (duplicates.length > 0) {
      throw new ConflictException(
        biBody(
          `Lessons already in package: ${duplicates.join(', ')}`,
          `الدروس التالية موجودة بالفعل في الباقة: ${duplicates.join(', ')}`,
        ),
      );
    }

    const totalAfter = pkg.items.length + dto.lessons.length;
    if (totalAfter > 20) {
      throw new BadRequestException(
        biBody('Maximum 20 lessons per package', 'الحد الأقصى 20 درسًا لكل باقة'),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const items = dto.lessons.map((lesson) =>
        manager.create(LessonPackageItem, {
          package_id: packageId,
          lesson_id: lesson.lessonId,
          order_index: lesson.orderIndex,
        }),
      );
      await manager.save(LessonPackageItem, items);
    });

    await this.calculateOriginalPrice(packageId);

    return await this.findOne(packageId);
  }

  /**
   * Remove lessons from a package
   */
  public async removeLessons(
    packageId: string,
    teacherId: string,
    dto: RemoveLessonsDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
      relations: ['items'],
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only modify your own packages', 'يمكنك تعديل باقاتك الخاصة فقط'),
      );
    }

    await this.packageItemsRepository
      .createQueryBuilder()
      .delete()
      .from(LessonPackageItem)
      .where('package_id = :packageId', { packageId })
      .andWhere('lesson_id IN (:...lessonIds)', { lessonIds: dto.lessonIds })
      .execute();

    await this.calculateOriginalPrice(packageId);

    return await this.findOne(packageId);
  }

  /**
   * Calculate and update original price (sum of lesson prices)
   */
  public async calculateOriginalPrice(packageId: string): Promise<number> {
    const result = (await this.packageItemsRepository
      .createQueryBuilder('item')
      .leftJoin('item.lesson', 'lesson')
      .where('item.package_id = :packageId', { packageId })
      .select('SUM(lesson.price)', 'total')
      .getRawOne<{ total: string | null }>()) ?? { total: null };

    const originalPrice = result.total === null ? 0 : Number.parseFloat(result.total);

    await this.packagesRepository.update(packageId, {
      original_price: originalPrice,
    });

    return originalPrice;
  }

  /**
   * Reorder lessons in a package
   */
  public async reorderLessons(
    packageId: string,
    teacherId: string,
    orderMap: Record<number, number>,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only modify your own packages', 'يمكنك تعديل باقاتك الخاصة فقط'),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const [lessonId, orderIndex] of Object.entries(orderMap)) {
        await manager.update(
          LessonPackageItem,
          { package_id: packageId, lesson_id: Number.parseInt(lessonId) },
          { order_index: orderIndex },
        );
      }
    });

    return await this.findOne(packageId);
  }

  /**
   * Toggle package active status
   */
  public async toggleActive(
    packageId: string,
    teacherId: string,
    isActive: boolean,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only modify your own packages', 'يمكنك تعديل باقاتك الخاصة فقط'),
      );
    }

    pkg.is_active = isActive;
    await this.packagesRepository.save(pkg);

    return await this.findOne(packageId);
  }

  /**
   * Get package statistics (placeholder for Purchases module)
   */
  public async getPackageStats(packageId: string): Promise<PackageStats> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    return {
      total_purchases: 0,
      total_revenue: 0,
      average_rating: 0,
    };
  }

  /**
   * Validate that all lessons belong to the teacher
   */
  public async validateLessonsOwnership(lessonIds: string[], teacherId: string): Promise<void> {
    const lessons = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.id IN (:...lessonIds)', { lessonIds })
      .andWhere('lesson.deleted_at IS NULL')
      .getMany();

    if (lessons.length !== lessonIds.length) {
      const foundIds = new Set(lessons.map((l) => l.id));
      const missing = lessonIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(
        biBody(
          `Lessons not found: ${missing.join(', ')}`,
          `الدروس التالية غير موجودة: ${missing.join(', ')}`,
        ),
      );
    }

    const notOwned = lessons.filter((l) => l.teacher_id !== teacherId);
    if (notOwned.length > 0) {
      throw new ForbiddenException(
        biBody(
          'All lessons in a package must belong to you',
          'يجب أن تكون جميع الدروس في الباقة مملوكة لك',
        ),
      );
    }
  }

  /**
   * Map entity to PackageWithDetails interface
   */
  private mapToPackageWithDetails(pkg: LessonPackage): PackageWithDetails {
    const originalPrice =
      pkg.original_price !== null && pkg.original_price !== 0
        ? Number.parseFloat(pkg.original_price.toString())
        : null;
    const price = Number.parseFloat(pkg.price.toString());
    const savings = originalPrice === null ? null : Math.max(0, originalPrice - price);

    // `teacher` and `item.lesson` are LEFT-joined relations whose target
    // entities (User, Lesson) both have @DeleteDateColumn. TypeORM silently
    // excludes a soft-deleted joined row (appends `<alias>.deleted_at IS NULL`
    // to the join condition), so a package/item can legitimately hydrate with
    // `teacher: null` / `lesson: null` here even though the FK column itself
    // is non-nullable — e.g. after an admin bulk-deletes a teacher account
    // (bulk-operations.service.ts) that still has authored packages, or a
    // lesson is soft-deleted while still attached to a package.
    const validItems = pkg.items.filter((item) => item.lesson !== null);
    const sortedItems = [...validItems].sort((a, b) => a.order_index - b.order_index);

    return {
      id: pkg.id,
      title: pkg.title,
      title_ar: pkg.title_ar,
      description: pkg.description,
      description_ar: pkg.description_ar,
      teacher: pkg.teacher
        ? {
            id: pkg.teacher.id,
            name: pkg.teacher.name,
            email: pkg.teacher.email,
            profile_picture_url: pkg.teacher.profile_picture_url,
          }
        : null,
      price,
      original_price: originalPrice,
      savings,
      is_active: pkg.is_active,
      status: pkg.status,
      featured: pkg.featured,
      category: pkg.category,
      tags: pkg.tags,
      estimated_duration: pkg.estimated_duration,
      published_at: pkg.published_at,
      scheduled_publish_at: pkg.scheduled_publish_at,
      thumbnail: pkg.thumbnail,
      thumbnail_url: this.media.resolveThumbnailUrl(pkg.thumbnail),
      lessons_count: sortedItems.length,
      lessons: sortedItems.map((item) => ({
        id: item.lesson.id,
        title: item.lesson.title,
        title_ar: item.lesson.title_ar,
        price: Number.parseFloat(item.lesson.price.toString()),
        duration: item.lesson.duration,
        order_index: item.order_index,
        chapter_id: item.chapter_id,
      })),
      created_at: pkg.created_at,
      updated_at: pkg.updated_at,
    };
  }

  /* ===================== Course CMS: chapters & status ===================== */

  /** Verify the package exists and belongs to the teacher. */
  private async assertOwnership(packageId: string, teacherId: string): Promise<LessonPackage> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });
    if (!pkg) {
      throw new NotFoundException(
        biBody(`Course with ID ${packageId} not found`, `الدورة بالمعرّف ${packageId} غير موجودة`),
      );
    }
    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only manage your own courses', 'يمكنك إدارة دوراتك الخاصة فقط'),
      );
    }
    return pkg;
  }

  public async listChapters(packageId: string, teacherId: string): Promise<CourseChapter[]> {
    await this.assertOwnership(packageId, teacherId);
    return this.chaptersRepository.find({
      where: { package_id: packageId },
      order: { order_index: 'ASC' },
    });
  }

  public async createChapter(
    packageId: string,
    teacherId: string,
    dto: CreateChapterDto,
  ): Promise<CourseChapter> {
    await this.assertOwnership(packageId, teacherId);
    const orderIndex =
      dto.order_index ??
      (await this.chaptersRepository.count({
        where: { package_id: packageId },
      }));
    const chapter = this.chaptersRepository.create({
      package_id: packageId,
      title: dto.title,
      order_index: orderIndex,
    });
    return this.chaptersRepository.save(chapter);
  }

  public async updateChapter(
    packageId: string,
    chapterId: string,
    teacherId: string,
    dto: UpdateChapterDto,
  ): Promise<CourseChapter> {
    await this.assertOwnership(packageId, teacherId);
    const chapter = await this.chaptersRepository.findOne({
      where: { id: chapterId, package_id: packageId },
    });
    if (!chapter) {
      throw new NotFoundException(
        biBody(`Chapter with ID ${chapterId} not found`, `الفصل بالمعرّف ${chapterId} غير موجود`),
      );
    }
    Object.assign(chapter, dto);
    return this.chaptersRepository.save(chapter);
  }

  public async deleteChapter(
    packageId: string,
    chapterId: string,
    teacherId: string,
  ): Promise<void> {
    await this.assertOwnership(packageId, teacherId);
    const chapter = await this.chaptersRepository.findOne({
      where: { id: chapterId, package_id: packageId },
    });
    if (!chapter) {
      throw new NotFoundException(
        biBody(`Chapter with ID ${chapterId} not found`, `الفصل بالمعرّف ${chapterId} غير موجود`),
      );
    }
    // Lessons keep their place; FK ON DELETE SET NULL clears their chapter_id.
    await this.chaptersRepository.softRemove(chapter);
  }

  /**
   * Persist the whole curriculum order (lesson positions + chapter membership,
   * and optional chapter ordering) atomically.
   */
  public async reorderCurriculum(
    packageId: string,
    teacherId: string,
    dto: ReorderCurriculumDto,
  ): Promise<PackageWithDetails> {
    await this.assertOwnership(packageId, teacherId);

    // Validate referenced chapters belong to this course.
    const chapterIds = new Set(
      dto.items.map((i) => i.chapter_id).filter((c): c is string => typeof c === 'string'),
    );
    (dto.chapters ?? []).forEach((c) => chapterIds.add(c.id));
    if (chapterIds.size > 0) {
      const owned = await this.chaptersRepository.count({
        where: { package_id: packageId, id: In([...chapterIds]) },
      });
      if (owned !== chapterIds.size) {
        throw new BadRequestException(
          biBody(
            'One or more chapters do not belong to this course',
            'فصل واحد أو أكثر لا ينتمي إلى هذه الدورة',
          ),
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const itemRepo = manager.getRepository(LessonPackageItem);
      const chapterRepo = manager.getRepository(CourseChapter);

      for (const item of dto.items) {
        await itemRepo.update(
          { package_id: packageId, lesson_id: item.lesson_id },
          { order_index: item.order_index, chapter_id: item.chapter_id ?? null },
        );
      }
      for (const ch of dto.chapters ?? []) {
        await chapterRepo.update(
          { id: ch.id, package_id: packageId },
          { order_index: ch.order_index },
        );
      }
    });

    return this.findOne(packageId);
  }

  public async updateStatus(
    packageId: string,
    teacherId: string,
    status: CourseStatus,
  ): Promise<PackageWithDetails> {
    const pkg = await this.assertOwnership(packageId, teacherId);
    pkg.status = status;
    // Keep the legacy is_active flag consistent with the new status.
    pkg.is_active = status === CourseStatus.PUBLISHED;
    if (status === CourseStatus.PUBLISHED && pkg.published_at === null) {
      pkg.published_at = new Date();
    }
    await this.packagesRepository.save(pkg);
    return this.findOne(packageId);
  }

  /**
   * Auto-publish any draft course whose scheduled time has arrived.
   * Runs every 5 minutes.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  public async publishScheduledCourses(): Promise<void> {
    const due = await this.packagesRepository
      .createQueryBuilder('package')
      .where('package.status = :status', { status: CourseStatus.DRAFT })
      .andWhere('package.scheduled_publish_at IS NOT NULL')
      .andWhere('package.scheduled_publish_at <= :now', { now: new Date() })
      .andWhere('package.deleted_at IS NULL')
      .getMany();

    for (const pkg of due) {
      pkg.status = CourseStatus.PUBLISHED;
      pkg.is_active = true;
      pkg.published_at = new Date();
      pkg.scheduled_publish_at = null;
      await this.packagesRepository.save(pkg);
      this.logger.log(`Scheduled course ${pkg.id} auto-published`);
    }
  }
}
