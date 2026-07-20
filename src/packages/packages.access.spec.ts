import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { CourseStatus } from './entities/course-status.enum';
import type { LessonPackage } from './entities/lesson-package.entity';
import { PackagesService } from './packages.service';

function makePackage(overrides: Partial<LessonPackage> = {}): LessonPackage {
  return {
    id: 'package-1',
    teacher_id: 'teacher-1',
    title: 'Published package',
    title_ar: 'باقة منشورة',
    description: null,
    description_ar: null,
    teacher: {
      id: 'teacher-1',
      name: 'Teacher',
      email: 'teacher@example.test',
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
    published_at: new Date(),
    scheduled_publish_at: null,
    items: [],
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  } as unknown as LessonPackage;
}

function makeDetailQuery(result: LessonPackage | null): SelectQueryBuilder<LessonPackage> {
  const queryBuilder = {
    leftJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getOne: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<Partial<SelectQueryBuilder<LessonPackage>>>;
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy'] as const) {
    queryBuilder[method]!.mockReturnValue(queryBuilder as SelectQueryBuilder<LessonPackage>);
  }
  return queryBuilder as SelectQueryBuilder<LessonPackage>;
}

function buildService(options: {
  detail?: LessonPackage | null;
  ownership?: Pick<LessonPackage, 'id' | 'teacher_id'> | null;
}): { service: PackagesService; queryBuilder: SelectQueryBuilder<LessonPackage> } {
  const queryBuilder = makeDetailQuery(options.detail ?? null);
  const packages = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    findOne: jest.fn().mockResolvedValue(options.ownership ?? null),
  } as unknown as Repository<LessonPackage>;
  const service = new PackagesService(
    packages,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as DataSource,
    { resolveThumbnailUrl: jest.fn().mockReturnValue(null) } as never,
  );
  return { service, queryBuilder };
}

describe('PackagesService access policy', () => {
  it('returns an existing active, published public package', async () => {
    const { service } = buildService({ detail: makePackage() });

    await expect(service.findPublicOne('package-1')).resolves.toMatchObject({
      id: 'package-1',
    });
  });

  it('returns 404 for a soft-deleted package', async () => {
    const { service, queryBuilder } = buildService({ detail: null });

    await expect(service.findPublicOne('deleted-package')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('package.deleted_at IS NULL');
  });

  it('filters unpublished packages from the public detail endpoint', async () => {
    const { service, queryBuilder } = buildService({ detail: null });

    await expect(service.findPublicOne('draft-package')).rejects.toBeInstanceOf(NotFoundException);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('package.is_active = :isActive', {
      isActive: true,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('package.status = :status', {
      status: CourseStatus.PUBLISHED,
    });
  });

  it("returns 403 when a teacher requests another teacher's package", async () => {
    const { service } = buildService({
      ownership: { id: 'other-package', teacher_id: 'teacher-2' },
    });

    await expect(service.findOneForTeacher('other-package', 'teacher-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
