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
    leftJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getCount: jest.fn().mockResolvedValue(packages.length),
    getMany: jest.fn().mockResolvedValue(packages),
    getOne: jest.fn().mockResolvedValue(packages[0] ?? null),
  };

  for (const method of [
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
    expect(result.data[0]!.lessons).toHaveLength(1);
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
    // Only the valid item should surface; the orphaned one is dropped from
    // both the list and the count so they stay consistent with each other.
    expect(result.data[0]!.lessons).toHaveLength(1);
    expect(result.data[0]!.lessons_count).toBe(1);
    expect(result.data[0]!.lessons[0]!.id).toBe('lesson-1');
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
