import type { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { CourseStatus } from './entities/course-status.enum';
import type { LessonPackage } from './entities/lesson-package.entity';
import { PackagesService } from './packages.service';

/**
 * Regression coverage for GET /admin/packages 500ing with
 * "Cannot read properties of null (reading 'id')".
 *
 * Root cause: `findAll()` LEFT JOINs `package.teacher` and `items.lesson`.
 * Both `User` and `Lesson` have `@DeleteDateColumn`, so TypeORM automatically
 * appends `<alias>.deleted_at IS NULL` to those joins (see
 * node_modules/typeorm/query-builder/SelectQueryBuilder.js) — a soft-deleted
 * teacher or lesson silently hydrates as `null` on the entity even though the
 * FK column itself is non-nullable. `mapToPackageWithDetails` previously
 * dereferenced `pkg.teacher.id` / `item.lesson.id` unconditionally.
 */
function buildQueryBuilder(
  packages: LessonPackage[],
): jest.Mocked<Partial<SelectQueryBuilder<LessonPackage>>> {
  const builder: jest.Mocked<Partial<SelectQueryBuilder<LessonPackage>>> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
    leftJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getCount: jest.fn().mockResolvedValue(packages.length),
    // T085: findAll pages ids first (clone/select/offset/limit/getRawMany), then hydrates them with getMany.
    // The page statement also returns each package's LIVE lesson count (items whose lesson was not soft-deleted).
    getRawMany: jest.fn().mockResolvedValue(
      packages.map((pkg) => ({
        id: pkg.id,
        lessons_count: String(pkg.items.filter((item) => item.lesson !== null).length),
      })),
    ),
    getMany: jest.fn().mockResolvedValue(packages),
    getOne: jest.fn().mockResolvedValue(packages[0] ?? null),
  };

  builder['clone'] = jest.fn().mockReturnValue(builder);
  for (const method of [
    'select',
    'addSelect',
    'offset',
    'limit',
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ] as const) {
    builder[method]!.mockReturnValue(builder as SelectQueryBuilder<LessonPackage>);
  }

  return builder;
}

function buildService(packages: LessonPackage[]): PackagesService {
  const packagesRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(buildQueryBuilder(packages)),
  } as unknown as Repository<LessonPackage>;

  const media = {
    resolveThumbnailUrl: jest.fn((value: string | null) =>
      value ? `https://api.example.test/api/v1/media/public/${value}` : null,
    ),
  };

  const applicationCache = {
    getOrCompute: jest.fn((_descriptor: unknown, compute: () => unknown) => compute()),
  };

  return new PackagesService(
    packagesRepository,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as Repository<never>,
    {} as DataSource,
    media as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    applicationCache as never,
  );
}

function makePackage(overrides: Partial<LessonPackage> = {}): LessonPackage {
  return {
    id: 'pkg-1',
    title: 'Algebra Basics',
    title_ar: 'أساسيات الجبر',
    description: null,
    description_ar: null,
    teacher_id: 'teacher-1',
    teacher: {
      id: 'teacher-1',
      name: 'Ms. Sara',
      email: 'sara@example.com',
      profile_picture_url: null,
    },
    price: 100,
    original_price: null,
    is_active: true,
    thumbnail: null,
    status: CourseStatus.PUBLISHED,
    featured: false,
    category: null,
    tags: null,
    estimated_duration: null,
    published_at: null,
    scheduled_publish_at: null,
    items: [
      {
        id: 'item-1',
        package_id: 'pkg-1',
        lesson_id: 'lesson-1',
        lesson: {
          id: 'lesson-1',
          title: 'Intro',
          title_ar: 'مقدمة',
          price: 0,
          duration: 30,
        },
        order_index: 0,
        chapter_id: null,
      },
    ],
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  } as unknown as LessonPackage;
}

describe('PackagesService.findAll', () => {
  it('uses the same resolved thumbnail_url public contract for list and detail', async () => {
    const service = buildService([makePackage({ thumbnail: 'images/cover.jpg' })]);

    const list = await service.findAllPublic({ page: 1, limit: 20 });
    const detail = await service.findPublicOne('pkg-1');

    expect(list.data[0]).toMatchObject({
      thumbnail_url: 'https://api.example.test/api/v1/media/public/images/cover.jpg',
    });
    expect(detail).toMatchObject({
      thumbnail_url: 'https://api.example.test/api/v1/media/public/images/cover.jpg',
    });
    expect(list.data[0]).not.toHaveProperty('thumbnail');
    expect(detail).not.toHaveProperty('thumbnail');
  });

  it('maps a normal package (teacher + lesson present) unchanged', async () => {
    const service = buildService([makePackage()]);

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.teacher).toEqual({
      id: 'teacher-1',
      name: 'Ms. Sara',
      profile_picture_url: null,
    });
    expect(JSON.stringify(result.data[0])).not.toContain('sara@example.com');
    // T087: list rows carry the count only; `lessons[]` belongs to the detail response.
    expect(result.data[0]).not.toHaveProperty('lessons');
    expect(result.data[0]!.lessons_count).toBe(1);
  });

  it('does not throw when the teacher relation is null (soft-deleted teacher) and returns teacher: null', async () => {
    const orphaned = makePackage({ teacher: null } as never);

    const service = buildService([orphaned]);

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.teacher).toBeNull();
  });

  it('does not throw when an item.lesson relation is null (soft-deleted lesson) and excludes it from lessons/lessons_count', async () => {
    const withOrphanedItem = makePackage();
    (withOrphanedItem.items as unknown[]) = [
      ...withOrphanedItem.items,
      {
        id: 'item-2',
        package_id: 'pkg-1',
        lesson_id: 'lesson-deleted',
        lesson: null,
        order_index: 1,
        chapter_id: null,
      },
    ];

    const service = buildService([withOrphanedItem]);

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    // The orphaned (soft-deleted lesson) item is not counted.
    expect(result.data[0]).not.toHaveProperty('lessons');
    expect(result.data[0]!.lessons_count).toBe(1);
  });

  it('lessons_count sort: orders by an aliased live-lesson subquery with an id tie-breaker, then hydrates the page by ids (T085)', async () => {
    const builder = buildQueryBuilder([makePackage(), makePackage({ id: 'pkg-2' })]);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
    const service = new PackagesService(
      repository as never,
      ...Array.from({ length: 5 }, () => ({}) as never),
      {} as never,
      { resolveThumbnailUrl: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrCompute: jest.fn() } as never,
    );

    await service.findAll({ page: 2, limit: 5, sortBy: 'lessons_count' as never, order: 'asc' });

    const [expression, alias] = builder.addSelect!.mock.calls[0] as [string, string];
    expect(alias).toBe('lessons_count');
    expect(expression).toContain('item_lesson.deleted_at IS NULL');
    expect(builder.orderBy).toHaveBeenCalledWith('lessons_count', 'ASC');
    expect(builder.addOrderBy).toHaveBeenCalledWith('package.id', 'ASC');
    expect(builder.offset).toHaveBeenCalledWith(5);
    expect(builder.limit).toHaveBeenCalledWith(5);
    // Pagination is no longer skip/take over the to-many joins.
    expect(builder.skip).not.toHaveBeenCalled();
    expect(builder.take).not.toHaveBeenCalled();
  });

  it('computes pagination meta correctly', async () => {
    const service = buildService([makePackage(), makePackage({ id: 'pkg-2' })]);

    const result = await service.findAll({ page: 1, limit: 1 });

    expect(result.meta).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });
  });
});
