import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { CertificateTemplate, CertificateTemplateStatus } from '../certificates/entities';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { LearningMetricsService, ProductFinancialMetricsService } from '../common/metrics';
import { retryTransaction } from '../common/utils/transaction-retry.util';
import { biBody } from '../i18n/error-translator.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { MediaService } from '../media/media.service';
import { ItemType } from '../payments/entities/item-type.enum';
import { fromMinorUnits } from '../payments/money.util';
import { ReviewsService } from '../reviews/reviews.service';
import { Subject } from '../subjects/entities/subject.entity';
import { usableSubjectByIdWhere } from '../subjects/subject-visibility.util';
import { User } from '../users/entities/user.entity';
import {
  AddLessonsDto,
  CreateChapterDto,
  CreatePackageDto,
  PackageFilterDto,
  PackageSortBy,
  PublicPackageResponseDto,
  RemoveLessonsDto,
  ReorderCurriculumDto,
  UpdateChapterDto,
  UpdatePackageDto,
  toPublicPackageResponse,
} from './dto';
import { CourseChapter } from './entities/course-chapter.entity';
import { CourseStatus } from './entities/course-status.enum';
import { CourseVersion } from './entities/course-version.entity';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';

/** T038 (W1-C6 d): anonymous, viewer-independent public catalog reads. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

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
    profile_picture_url: string | null;
  } | null;
  subject: { id: string; name: string } | null;
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
  certificate_template_id: string | null;
  lessons_count: number;
  lessons: Array<{
    id: string;
    title: string;
    price: number;
    duration: number | null;
    order_index: number;
    chapter_id: string | null;
  }>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Statistics for one course, as returned by `GET /admin/packages/:id/stats`.
 *
 * ## Course-version aggregation policy
 * These are **product-level** stats for the course's public identity, summed
 * over every version of it. `orders.item_id` is the course id regardless of
 * which `CourseVersion` was current at checkout, so financial totals are
 * naturally version-agnostic; `unique_students` uses `COUNT(DISTINCT
 * student_id)` so a student who re-bought after a curriculum change is one
 * student, not two. `purchased_version_count` is the escape hatch for
 * "how many snapshots are live" — per-version financial breakdowns are
 * deliberately not exposed, since no surface asks for them.
 *
 * Money is in major units (EGP), matching `package.price`.
 */
export interface PackageStats {
  /** Settled orders for this course, across all versions. */
  total_purchases: number;
  /** Unique students behind those orders; repeat buyers count once. */
  unique_students: number;
  /**
   * Unique students holding non-revoked `package_purchases` access. Differs
   * from `unique_students` when access was granted outside a settled order or
   * revoked after a full refund.
   */
  students_with_access: number;
  /** Distinct `CourseVersion`s with at least one live purchase. */
  purchased_version_count: number;
  /** **Net** revenue: charged after discount, minus refunds. */
  total_revenue: number;
  /** Charged after discount, before refunds. */
  gross_revenue: number;
  /** Discount granted at checkout across settled orders. */
  discount_amount: number;
  /** Cumulative refunds against settled orders. */
  refunded_amount: number;
  /** Teacher entitlement after proportional refund reversal. */
  teacher_earnings: number;
  /** Platform commission after proportional refund reversal. */
  platform_commission: number;
  /** Currency of every monetary field above. */
  currency: string;
  /** True when settled orders span more than one currency. */
  mixed_currency: boolean;
  /**
   * Mean approved rating of the lessons in this course — courses have no review
   * table of their own, so `ReviewsService.getPackageAggregates` rolls up the
   * approved `lesson_reviews` of its curriculum. **`null` means "not yet
   * rated"**, never 0 stars.
   */
  average_rating: number | null;
  /** Approved lesson reviews backing `average_rating`. */
  review_count: number;
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
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly dataSource: DataSource,
    private readonly media: MediaService,
    private readonly productFinancialMetrics: ProductFinancialMetricsService,
    private readonly learningMetrics: LearningMetricsService,
    private readonly reviewsService: ReviewsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly applicationCache: ApplicationCacheService,
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

    const subject = await this.subjectsRepository.findOne({
      where: usableSubjectByIdWhere(dto.subject_id, teacherId),
    });
    if (!subject) {
      throw new BadRequestException(
        biBody(
          `Subject with ID ${dto.subject_id} not found`,
          `المادة بالمعرّف ${dto.subject_id} غير موجودة`,
        ),
      );
    }

    if (dto.certificate_template_id !== undefined) {
      await this.assertTemplateAssignable(teacherId, dto.certificate_template_id);
    }

    const packageInput = Object.assign({}, dto, {
      teacher_id: teacherId,
      // Course can be single-language: fall back to `title` for `title_ar`.
      title_ar: dto.title_ar ?? dto.title,
      is_active: true,
      original_price: null,
    });
    if (dto.thumbnail !== undefined) {
      packageInput.thumbnail = this.media.normalizeStoredPublicReference(dto.thumbnail);
    }

    // Every course starts on an unlocked draft version 1: its content lives
    // in `LessonPackageItem` until a purchase locks it (see
    // `ensureOpenVersionForEdit` and `PaymentFinalizationService`).
    const savedPackage = await this.dataSource.transaction(async (manager) => {
      const pkg = manager.create(LessonPackage, packageInput);
      const saved = await manager.save(LessonPackage, pkg);
      const version = await manager.save(
        CourseVersion,
        manager.create(CourseVersion, {
          package_id: saved.id,
          version_number: 1,
          locked_at: null,
        }),
      );
      await manager.update(LessonPackage, { id: saved.id }, { current_version_id: version.id });
      return saved;
    });

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
      .leftJoinAndSelect('package.subject', 'subject')
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

    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    queryBuilder.orderBy(sortColumn, sortOrder).addOrderBy('package.id', sortOrder);

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
   * Cached (T038, W1-C6 d): backs `GET packages` and, via `findByTeacherPublic`,
   * `GET packages/teacher/:teacherId`.
   */
  public async findAllPublic(
    filter: PackageFilterDto,
  ): Promise<PaginatedResponse<PublicPackageResponseDto>> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'packages.list',
        scope: 'public',
        parts: [
          (filter.search ?? '').trim().toLowerCase(),
          filter.teacher_id ?? null,
          filter.minPrice ?? null,
          filter.maxPrice ?? null,
          filter.sortBy ?? PackageSortBy.CREATED_AT,
          filter.order ?? 'desc',
          filter.page ?? 1,
          filter.limit ?? 20,
        ],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computeAllPublic(filter),
    );
  }

  private async computeAllPublic(
    filter: PackageFilterDto,
  ): Promise<PaginatedResponse<PublicPackageResponseDto>> {
    const result = await this.findAll(filter);
    return {
      data: result.data.map((pkg) =>
        toPublicPackageResponse(pkg, (value) => this.media.resolveThumbnailUrl(value)),
      ),
      meta: result.meta,
    };
  }

  public async findByTeacherPublic(
    teacherId: string,
    filter: Omit<PackageFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PublicPackageResponseDto>> {
    return await this.findAllPublic({ ...filter, teacher_id: teacherId });
  }

  /**
   * Find a single package by ID for internal/admin use. This intentionally
   * includes draft and inactive packages; callers must apply their own role
   * policy rather than weakening the public catalogue policy.
   */
  public async findOne(id: string): Promise<PackageWithDetails> {
    return this.findDetailedPackage(id);
  }

  /**
   * Public package detail: only an active, published, non-deleted course.
   * Cached (T038, W1-C6 d); a 404 is thrown inside the compute callback, so
   * `getOrCompute` never stores a "not found" result.
   */
  public async findPublicOne(id: string): Promise<PublicPackageResponseDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'packages.detail',
        scope: 'public',
        parts: [id],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computePublicOne(id),
    );
  }

  private async computePublicOne(id: string): Promise<PublicPackageResponseDto> {
    const pkg = await this.findDetailedPackage(id, {
      is_active: true,
      status: CourseStatus.PUBLISHED,
    });
    return toPublicPackageResponse(pkg, (value) => this.media.resolveThumbnailUrl(value));
  }

  /** Teacher detail: distinguish an absent package (404) from another owner's package (403). */
  public async findOneForTeacher(id: string, teacherId: string): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id, deleted_at: IsNull() },
      select: { id: true, teacher_id: true },
    });
    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${id} not found`, `الباقة بالمعرّف ${id} غير موجودة`),
      );
    }
    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only access your own packages', 'يمكنك فقط الوصول إلى باقاتك الخاصة'),
      );
    }
    return this.findOne(id);
  }

  private async findDetailedPackage(
    id: string,
    visibility?: { is_active: boolean; status: CourseStatus },
  ): Promise<PackageWithDetails> {
    const queryBuilder = this.packagesRepository
      .createQueryBuilder('package')
      .leftJoinAndSelect('package.teacher', 'teacher')
      .leftJoinAndSelect('package.subject', 'subject')
      .leftJoinAndSelect('package.items', 'items')
      .leftJoinAndSelect('items.lesson', 'lesson')
      .where('package.id = :id', { id })
      .andWhere('package.deleted_at IS NULL');

    if (visibility) {
      queryBuilder
        .andWhere('package.is_active = :isActive', { isActive: visibility.is_active })
        .andWhere('package.status = :status', { status: visibility.status });
    }

    const pkg = await queryBuilder.orderBy('items.order_index', 'ASC').getOne();

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

    // Only validated when the subject is actually changing: re-checking an
    // unchanged subject_id would make every course on a suspended subject
    // uneditable.
    if (dto.subject_id !== undefined && dto.subject_id !== pkg.subject_id) {
      const subject = await this.subjectsRepository.findOne({
        where: usableSubjectByIdWhere(dto.subject_id, teacherId),
      });
      if (!subject) {
        throw new BadRequestException(
          biBody(
            `Subject with ID ${dto.subject_id} not found`,
            `المادة بالمعرّف ${dto.subject_id} غير موجودة`,
          ),
        );
      }
    }

    if (dto.certificate_template_id !== undefined && dto.certificate_template_id !== null) {
      await this.assertTemplateAssignable(teacherId, dto.certificate_template_id);
    }

    Object.assign(pkg, dto);
    if (dto.thumbnail !== undefined) {
      pkg.thumbnail = this.media.normalizeStoredPublicReference(dto.thumbnail);
    }
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
   * Locks the package row and its current version (serializing against a
   * concurrent payment finalization racing to lock the same version — see
   * `PaymentFinalizationService.writeCompatibilityPurchase`). If that version
   * is already locked (it has been sold at least once), it must never be
   * mutated again: roll over to a fresh unlocked version and repoint the
   * package at it before the caller applies its `LessonPackageItem` edit. If
   * it is still an unsold draft, the caller edits it in place — "editing an
   * unsold draft is allowed."
   *
   * Must be called as the first statement inside the same transaction that
   * performs the `LessonPackageItem` mutation.
   */
  private async ensureOpenVersionForEdit(manager: EntityManager, packageId: string): Promise<void> {
    const pkg = await manager.findOne(LessonPackage, {
      where: { id: packageId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!pkg?.current_version_id) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }
    const version = await manager.findOne(CourseVersion, {
      where: { id: pkg.current_version_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!version) {
      throw new NotFoundException(biBody('Course version not found', 'إصدار الدورة غير موجود'));
    }
    if (version.locked_at === null) {
      // Still an unsold draft — the caller may mutate LessonPackageItem
      // directly, no rollover needed.
      return;
    }
    const rolledOver = await manager.save(
      CourseVersion,
      manager.create(CourseVersion, {
        package_id: packageId,
        version_number: version.version_number + 1,
        locked_at: null,
      }),
    );
    await manager.update(LessonPackage, { id: packageId }, { current_version_id: rolledOver.id });
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

    await retryTransaction(this.dataSource, async (manager) => {
      await this.ensureOpenVersionForEdit(manager, packageId);
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

    await retryTransaction(this.dataSource, async (manager) => {
      await this.ensureOpenVersionForEdit(manager, packageId);
      await manager
        .createQueryBuilder()
        .delete()
        .from(LessonPackageItem)
        .where('package_id = :packageId', { packageId })
        .andWhere('lesson_id IN (:...lessonIds)', { lessonIds: dto.lessonIds })
        .execute();
    });

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
   * Course statistics from the canonical sources only — settled `orders` for
   * money and purchase counts, `package_purchases` for live access, and the
   * approved lesson reviews of the curriculum for the rating.
   *
   * Replaces the three hardcoded zeros this method used to return (DEF-007).
   * See {@link PackageStats} for the version-aggregation policy.
   */
  public async getPackageStats(packageId: string): Promise<PackageStats> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
      select: { id: true },
    });

    if (!pkg) {
      throw new NotFoundException(
        biBody(`Package with ID ${packageId} not found`, `الباقة بالمعرّف ${packageId} غير موجودة`),
      );
    }

    const [financial, engagement, rating] = await Promise.all([
      this.productFinancialMetrics.getProductFinancialMetrics(ItemType.PACKAGE, packageId),
      this.learningMetrics.getPackageEngagementMetrics(packageId),
      this.reviewsService.getPackageAggregates(packageId),
    ]);

    const money = financial.primary;
    return {
      total_purchases: money.order_count,
      unique_students: money.unique_student_count,
      students_with_access: engagement.students_with_access,
      purchased_version_count: engagement.purchased_version_count,
      total_revenue: fromMinorUnits(money.net_revenue_minor),
      gross_revenue: fromMinorUnits(money.gross_sales_minor),
      discount_amount: fromMinorUnits(money.discount_amount_minor),
      refunded_amount: fromMinorUnits(money.refund_amount_minor),
      teacher_earnings: fromMinorUnits(money.teacher_earnings_minor),
      platform_commission: fromMinorUnits(money.platform_commission_minor),
      currency: money.currency,
      mixed_currency: financial.mixed_currency,
      average_rating: rating.total_reviews === 0 ? null : rating.average_rating,
      review_count: rating.total_reviews,
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
    const individual = lessons.filter((lesson) => !lesson.is_group);
    if (individual.length > 0) {
      throw new BadRequestException(
        biBody(
          'Individual lessons cannot be added to packages',
          'Individual lessons cannot be added to packages',
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
            profile_picture_url: pkg.teacher.profile_picture_url,
          }
        : null,
      subject: pkg.subject
        ? {
            id: pkg.subject.id,
            name: pkg.subject.name,
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
      certificate_template_id: pkg.certificate_template_id,
      lessons_count: sortedItems.length,
      lessons: sortedItems.map((item) => ({
        id: item.lesson.id,
        title: item.lesson.title,
        price: Number.parseFloat(item.lesson.price.toString()),
        duration: item.lesson.duration,
        order_index: item.order_index,
        chapter_id: item.chapter_id,
      })),
      created_at: pkg.created_at,
      updated_at: pkg.updated_at,
    };
  }

  /** A course can reference only a published template owned by its teacher or the platform. */
  private async assertTemplateAssignable(teacherId: string, templateId: string): Promise<void> {
    const template = await this.dataSource
      .getRepository(CertificateTemplate)
      .createQueryBuilder('template')
      .where('template.id = :templateId', { templateId })
      .andWhere('template.status = :status', { status: CertificateTemplateStatus.PUBLISHED })
      .andWhere('(template.owner_id = :teacherId OR template.owner_id IS NULL)', { teacherId })
      .getOne();
    if (!template) {
      throw new BadRequestException(
        biBody(
          'Certificate template must be a published template you own or a published platform template',
          'يجب أن يكون قالب الشهادة منشوراً ومملوكاً لك أو قالباً منشوراً للمنصة',
        ),
      );
    }
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
      order: { order_index: 'ASC', id: 'ASC' },
      take: 500,
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
      title_ar: dto.title_ar ?? null,
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
    const isNewlyPublished = status === CourseStatus.PUBLISHED && pkg.published_at === null;
    pkg.status = status;
    // Keep the legacy is_active flag consistent with the new status.
    pkg.is_active = status === CourseStatus.PUBLISHED;
    if (isNewlyPublished) {
      pkg.published_at = new Date();
    }
    await this.packagesRepository.save(pkg);
    if (isNewlyPublished) {
      this.eventEmitter.emit('package.published', {
        packageId: pkg.id,
        title: pkg.title,
        teacherId: pkg.teacher_id,
      });
    }
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
      this.eventEmitter.emit('package.published', {
        packageId: pkg.id,
        title: pkg.title,
        teacherId: pkg.teacher_id,
      });
      this.logger.log(`Scheduled course ${pkg.id} auto-published`);
    }
  }
}
