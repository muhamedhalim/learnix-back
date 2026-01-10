import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { User } from '../users/entities/user.entity';
import {
  CreatePackageDto,
  UpdatePackageDto,
  AddLessonsDto,
  RemoveLessonsDto,
  PackageFilterDto,
  PackageSortBy,
} from './dto';
import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';

export interface PackageWithDetails {
  id: number;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  teacher: {
    id: string;
    name: string;
    email: string;
    profile_picture_url: string | null;
  };
  price: number;
  original_price: number | null;
  savings: number | null;
  is_active: boolean;
  thumbnail: string | null;
  lessons_count: number;
  lessons: Array<{
    id: number;
    title: string;
    title_ar: string;
    price: number;
    duration: number | null;
    order_index: number;
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
  constructor(
    @InjectRepository(LessonPackage)
    private packagesRepository: Repository<LessonPackage>,
    @InjectRepository(LessonPackageItem)
    private packageItemsRepository: Repository<LessonPackageItem>,
    @InjectRepository(Lesson)
    private lessonsRepository: Repository<Lesson>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private dataSource: DataSource,
  ) {}

  /**
   * Create a new lesson package
   */
  async create(
    teacherId: string,
    dto: CreatePackageDto,
  ): Promise<PackageWithDetails> {
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    const pkg = this.packagesRepository.create({
      ...dto,
      teacher_id: teacherId,
      is_active: true,
      original_price: null,
    });

    const savedPackage = await this.packagesRepository.save(pkg);
    return this.findOne(savedPackage.id);
  }

  /**
   * Find all packages with filtering and pagination
   */
  async findAll(
    filter: PackageFilterDto,
  ): Promise<PaginatedResponse<PackageWithDetails>> {
    const {
      search,
      teacher_id,
      minPrice,
      maxPrice,
      is_active,
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

    if (search) {
      queryBuilder.andWhere(
        '(package.title ILIKE :search OR package.title_ar ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (teacher_id) {
      queryBuilder.andWhere('package.teacher_id = :teacher_id', { teacher_id });
    }

    if (minPrice !== undefined) {
      queryBuilder.andWhere('package.price >= :minPrice', { minPrice });
    }

    if (maxPrice !== undefined) {
      queryBuilder.andWhere('package.price <= :maxPrice', { maxPrice });
    }

    if (is_active !== undefined) {
      queryBuilder.andWhere('package.is_active = :is_active', { is_active });
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
  async findByTeacher(
    teacherId: string,
    filter: Omit<PackageFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PackageWithDetails>> {
    return this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Find a single package by ID
   */
  async findOne(id: number): Promise<PackageWithDetails> {
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
      throw new NotFoundException(`Package with ID ${id} not found`);
    }

    return this.mapToPackageWithDetails(pkg);
  }

  /**
   * Update a package (ownership check)
   */
  async update(
    packageId: number,
    teacherId: string,
    dto: UpdatePackageDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own packages');
    }

    Object.assign(pkg, dto);
    await this.packagesRepository.save(pkg);

    return this.findOne(packageId);
  }

  /**
   * Delete a package (ownership check)
   */
  async delete(packageId: number, teacherId: string): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only delete your own packages');
    }

    await this.packagesRepository.softDelete(packageId);
  }

  /**
   * Admin delete (no ownership check)
   */
  async adminDelete(packageId: number): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    await this.packagesRepository.softDelete(packageId);
  }

  /**
   * Find teacher's own packages
   */
  async findMyPackages(
    teacherId: string,
    filter: Omit<PackageFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PackageWithDetails>> {
    return this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Add lessons to a package (with transaction)
   */
  async addLessons(
    packageId: number,
    teacherId: string,
    dto: AddLessonsDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
      relations: ['items'],
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only modify your own packages');
    }

    const lessonIds = dto.lessons.map((l) => l.lessonId);
    await this.validateLessonsOwnership(lessonIds, teacherId);

    const existingLessonIds = pkg.items.map((item) => item.lesson_id);
    const duplicates = lessonIds.filter((id) => existingLessonIds.includes(id));
    if (duplicates.length > 0) {
      throw new ConflictException(
        `Lessons already in package: ${duplicates.join(', ')}`,
      );
    }

    const totalAfter = pkg.items.length + dto.lessons.length;
    if (totalAfter > 20) {
      throw new BadRequestException('Maximum 20 lessons per package');
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

    return this.findOne(packageId);
  }

  /**
   * Remove lessons from a package
   */
  async removeLessons(
    packageId: number,
    teacherId: string,
    dto: RemoveLessonsDto,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
      relations: ['items'],
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only modify your own packages');
    }

    await this.packageItemsRepository
      .createQueryBuilder()
      .delete()
      .from(LessonPackageItem)
      .where('package_id = :packageId', { packageId })
      .andWhere('lesson_id IN (:...lessonIds)', { lessonIds: dto.lessonIds })
      .execute();

    await this.calculateOriginalPrice(packageId);

    return this.findOne(packageId);
  }

  /**
   * Calculate and update original price (sum of lesson prices)
   */
  async calculateOriginalPrice(packageId: number): Promise<number> {
    const result: { total: string | null } | undefined =
      await this.packageItemsRepository
        .createQueryBuilder('item')
        .leftJoin('item.lesson', 'lesson')
        .where('item.package_id = :packageId', { packageId })
        .select('SUM(lesson.price)', 'total')
        .getRawOne();

    const originalPrice = result?.total ? parseFloat(result.total) : 0;

    await this.packagesRepository.update(packageId, {
      original_price: originalPrice,
    });

    return originalPrice;
  }

  /**
   * Reorder lessons in a package
   */
  async reorderLessons(
    packageId: number,
    teacherId: string,
    orderMap: Record<number, number>,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only modify your own packages');
    }

    await this.dataSource.transaction(async (manager) => {
      for (const [lessonId, orderIndex] of Object.entries(orderMap)) {
        await manager.update(
          LessonPackageItem,
          { package_id: packageId, lesson_id: parseInt(lessonId) },
          { order_index: orderIndex },
        );
      }
    });

    return this.findOne(packageId);
  }

  /**
   * Toggle package active status
   */
  async toggleActive(
    packageId: number,
    teacherId: string,
    isActive: boolean,
  ): Promise<PackageWithDetails> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
    }

    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only modify your own packages');
    }

    pkg.is_active = isActive;
    await this.packagesRepository.save(pkg);

    return this.findOne(packageId);
  }

  /**
   * Get package statistics (placeholder for Purchases module)
   */
  async getPackageStats(packageId: number): Promise<PackageStats> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${packageId} not found`);
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
  async validateLessonsOwnership(
    lessonIds: number[],
    teacherId: string,
  ): Promise<void> {
    const lessons = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.id IN (:...lessonIds)', { lessonIds })
      .andWhere('lesson.deleted_at IS NULL')
      .getMany();

    if (lessons.length !== lessonIds.length) {
      const foundIds = lessons.map((l) => l.id);
      const missing = lessonIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundException(`Lessons not found: ${missing.join(', ')}`);
    }

    const notOwned = lessons.filter((l) => l.teacher_id !== teacherId);
    if (notOwned.length > 0) {
      throw new ForbiddenException(
        'All lessons in a package must belong to you',
      );
    }
  }

  /**
   * Map entity to PackageWithDetails interface
   */
  private mapToPackageWithDetails(pkg: LessonPackage): PackageWithDetails {
    const originalPrice = pkg.original_price
      ? parseFloat(pkg.original_price.toString())
      : null;
    const price = parseFloat(pkg.price.toString());
    const savings =
      originalPrice !== null ? Math.max(0, originalPrice - price) : null;

    const sortedItems = pkg.items
      ? [...pkg.items].sort((a, b) => a.order_index - b.order_index)
      : [];

    return {
      id: pkg.id,
      title: pkg.title,
      title_ar: pkg.title_ar,
      description: pkg.description,
      description_ar: pkg.description_ar,
      teacher: {
        id: pkg.teacher.id,
        name: pkg.teacher.name,
        email: pkg.teacher.email,
        profile_picture_url: pkg.teacher.profile_picture_url,
      },
      price,
      original_price: originalPrice,
      savings,
      is_active: pkg.is_active,
      thumbnail: pkg.thumbnail,
      lessons_count: sortedItems.length,
      lessons: sortedItems.map((item) => ({
        id: item.lesson.id,
        title: item.lesson.title,
        title_ar: item.lesson.title_ar,
        price: parseFloat(item.lesson.price.toString()),
        duration: item.lesson.duration,
        order_index: item.order_index,
      })),
      created_at: pkg.created_at,
      updated_at: pkg.updated_at,
    };
  }
}
