import type { DataSource, Repository } from 'typeorm';

import { CourseStatus } from './entities/course-status.enum';
import type { LessonPackage } from './entities/lesson-package.entity';
import { PackagesService } from './packages.service';

function makePackage(overrides: Partial<LessonPackage> = {}): LessonPackage {
  return {
    id: 'pkg-1',
    title: 'Algebra Basics',
    title_ar: 'أساسيات الجبر',
    description: null,
    description_ar: null,
    teacher_id: 'teacher-1',
    teacher: null,
    subject: null,
    price: 100,
    original_price: null,
    is_active: false,
    status: CourseStatus.DRAFT,
    featured: false,
    category: null,
    tags: [],
    estimated_duration: null,
    published_at: null,
    scheduled_publish_at: null,
    thumbnail: null,
    certificate_template_id: null,
    items: [],
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  } as unknown as LessonPackage;
}

function buildService(pkg: LessonPackage) {
  const detailBuilder = {
    leftJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getOne: jest.fn().mockResolvedValue(pkg),
  };
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy'] as const) {
    detailBuilder[method].mockReturnValue(detailBuilder);
  }
  const packagesRepository = {
    findOne: jest.fn().mockResolvedValue(pkg),
    save: jest.fn().mockResolvedValue(pkg),
    createQueryBuilder: jest.fn().mockReturnValue(detailBuilder),
  } as unknown as Repository<LessonPackage>;

  const media = { resolveThumbnailUrl: jest.fn().mockReturnValue(null) };
  const eventEmitter = { emit: jest.fn() };

  const service = new PackagesService(
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
    eventEmitter as never,
  );
  return { service, eventEmitter, packagesRepository };
}

describe('PackagesService.updateStatus — admin notification event', () => {
  it('emits package.published the first time a draft course is published', async () => {
    const pkg = makePackage({ status: CourseStatus.DRAFT, published_at: null });
    const { service, eventEmitter } = buildService(pkg);

    await service.updateStatus('pkg-1', 'teacher-1', CourseStatus.PUBLISHED);

    expect(eventEmitter.emit).toHaveBeenCalledWith('package.published', {
      packageId: 'pkg-1',
      title: 'Algebra Basics',
      teacherId: 'teacher-1',
    });
  });

  it('does not re-emit when a course already published is republished', async () => {
    const pkg = makePackage({ status: CourseStatus.PUBLISHED, published_at: new Date() });
    const { service, eventEmitter } = buildService(pkg);

    await service.updateStatus('pkg-1', 'teacher-1', CourseStatus.PUBLISHED);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does not emit when a course is unpublished (hidden)', async () => {
    const pkg = makePackage({ status: CourseStatus.PUBLISHED, published_at: new Date() });
    const { service, eventEmitter } = buildService(pkg);

    await service.updateStatus('pkg-1', 'teacher-1', CourseStatus.HIDDEN);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
