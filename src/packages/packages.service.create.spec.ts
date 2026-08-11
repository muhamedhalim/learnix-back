import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import type { Subject } from '../subjects/entities/subject.entity';
import { usableSubjectByIdWhere } from '../subjects/subject-visibility.util';
import type { User } from '../users/entities/user.entity';
import { CourseStatus } from './entities/course-status.enum';
import { CourseVersion } from './entities/course-version.entity';
import { LessonPackage } from './entities/lesson-package.entity';
import { PackagesService } from './packages.service';

/**
 * Regression coverage for POST /teacher/packages 500ing with
 * "null value in column subject_id of relation lesson_packages violates
 * not-null constraint". Root cause: `subject_id` has been NOT NULL at the DB
 * level since the initial migration, but the entity/DTO/service never mapped
 * it. These tests cover the restored subject_id support end-to-end at the
 * service layer.
 */

const TEACHER: User = {
  id: 'teacher-1',
  name: 'Ms. Sara',
} as unknown as User;

const SUBJECT: Subject = {
  id: 'subject-1',
  name: 'Algebra',
} as unknown as Subject;

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
    subject_id: 'subject-1',
    subject: SUBJECT,
    price: 100,
    original_price: null,
    is_active: true,
    thumbnail: null,
    status: CourseStatus.DRAFT,
    featured: false,
    category: null,
    tags: null,
    estimated_duration: null,
    published_at: null,
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
  teacher?: User | null;
  subject?: Subject | null;
  savedPackage?: LessonPackage;
}): {
  service: PackagesService;
  save: jest.Mock;
  create: jest.Mock;
  subjectsFindOne: jest.Mock;
  normalizeStoredPublicReference: jest.Mock;
} {
  const savedPackage = options.savedPackage ?? makePackage();
  const create = jest.fn().mockImplementation((entity: unknown) => entity);
  const save = jest.fn().mockResolvedValue(savedPackage);
  const packagesRepository = {
    create,
    save,
    createQueryBuilder: jest.fn().mockReturnValue(makeDetailQuery(savedPackage)),
  } as unknown as Repository<LessonPackage>;

  const usersRepository = {
    findOne: jest.fn().mockResolvedValue(options.teacher === undefined ? TEACHER : options.teacher),
  } as unknown as Repository<User>;

  const subjectsFindOne = jest
    .fn()
    .mockResolvedValue(options.subject === undefined ? SUBJECT : options.subject);
  const subjectsRepository = {
    findOne: subjectsFindOne,
  } as unknown as Repository<Subject>;

  const normalizeStoredPublicReference = jest.fn((value: string) => value);
  const media = {
    resolveThumbnailUrl: jest.fn().mockReturnValue(null),
    normalizeStoredPublicReference,
  };

  // `create()` now opens a transaction to atomically create the package
  // alongside its initial (unlocked) CourseVersion. Route the manager's
  // entity-aware create/save back through the same repository-level mocks
  // above so existing assertions on `create`/`save` still see exactly what
  // was persisted for the package itself.
  const dataSource = {
    transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) => {
      const manager = {
        create: (entity: unknown, value: unknown) => (entity === LessonPackage ? create(value) : value),
        save: (entity: unknown, value: unknown) =>
          entity === LessonPackage
            ? save(value)
            : entity === CourseVersion
              ? Promise.resolve({ id: 'version-1', ...(value as object) })
              : Promise.resolve(value),
        update: jest.fn().mockResolvedValue(undefined),
      };
      return work(manager);
    }),
  } as unknown as DataSource;

  const service = new PackagesService(
    packagesRepository,
    {} as never,
    {} as never,
    {} as never,
    usersRepository,
    subjectsRepository,
    dataSource,
    media as never,
  );

  return { service, save, create, subjectsFindOne, normalizeStoredPublicReference };
}

describe('PackagesService.create — subject_id', () => {
  it('creates a package with a valid subject and returns it populated', async () => {
    const { service, save, subjectsFindOne } = buildService({});

    const result = await service.create('teacher-1', {
      title: 'Algebra Basics',
      subject_id: 'subject-1',
      price: 100,
    } as never);

    // The subject lookup is scoped to what this teacher may use: the approved
    // catalogue, or their own submission still awaiting approval.
    expect(subjectsFindOne).toHaveBeenCalledWith({
      where: usableSubjectByIdWhere('subject-1', 'teacher-1'),
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ subject_id: 'subject-1', teacher_id: 'teacher-1' }),
    );
    expect(result.subject).toEqual({
      id: 'subject-1',
      name: 'Algebra',
    });
  });

  it('rejects a nonexistent subject_id with a 400 Bad Request (not 404, not a DB 500)', async () => {
    const { service, save } = buildService({ subject: null });

    await expect(
      service.create('teacher-1', {
        title: 'Algebra Basics',
        subject_id: 'missing-subject',
        price: 100,
      } as never),
    ).rejects.toThrow(BadRequestException);

    expect(save).not.toHaveBeenCalled();
  });

  it('still 404s when the teacher does not exist (unrelated to subject validation)', async () => {
    const { service } = buildService({ teacher: null });

    await expect(
      service.create('missing-teacher', {
        title: 'Algebra Basics',
        subject_id: 'subject-1',
        price: 100,
      } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('creates a draft package when status: "draft" is passed', async () => {
    const { service } = buildService({
      savedPackage: makePackage({ status: CourseStatus.DRAFT }),
    });

    const result = await service.create('teacher-1', {
      title: 'Algebra Basics',
      subject_id: 'subject-1',
      price: 100,
      status: CourseStatus.DRAFT,
    } as never);

    expect(result.status).toBe(CourseStatus.DRAFT);
  });

  it('creates a published package when status: "published" is passed', async () => {
    const { service } = buildService({
      savedPackage: makePackage({ status: CourseStatus.PUBLISHED }),
    });

    const result = await service.create('teacher-1', {
      title: 'Algebra Basics',
      subject_id: 'subject-1',
      price: 100,
      status: CourseStatus.PUBLISHED,
    } as never);

    expect(result.status).toBe(CourseStatus.PUBLISHED);
  });

  it('persists an uploaded cover as an environment-neutral storage key', async () => {
    const { service, create, normalizeStoredPublicReference } = buildService({});
    normalizeStoredPublicReference.mockReturnValue('images/cover.jpg');

    await service.create('teacher-1', {
      title: 'Algebra Basics',
      subject_id: 'subject-1',
      price: 100,
      thumbnail: 'http://localhost:3001/api/v1/media/public/images/cover.jpg',
    } as never);

    expect(normalizeStoredPublicReference).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/media/public/images/cover.jpg',
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ thumbnail: 'images/cover.jpg' }));
  });
});

describe('PackagesService.update — subject_id', () => {
  it('validates subject_id only when it is provided', async () => {
    const existing = makePackage();
    const packagesRepository = {
      findOne: jest.fn().mockResolvedValue(existing),
      save: jest.fn().mockResolvedValue(existing),
      createQueryBuilder: jest.fn().mockReturnValue(makeDetailQuery(existing)),
    } as unknown as Repository<LessonPackage>;
    const subjectsFindOne = jest.fn().mockResolvedValue(null);
    const subjectsRepository = { findOne: subjectsFindOne } as unknown as Repository<Subject>;

    const service = new PackagesService(
      packagesRepository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      subjectsRepository,
      {} as DataSource,
      {
        resolveThumbnailUrl: jest.fn().mockReturnValue(null),
        normalizeStoredPublicReference: jest.fn((value: string) => value),
      } as never,
    );

    // No subject_id in the DTO — must not touch subjectsRepository at all.
    await service.update('pkg-1', 'teacher-1', { title: 'Renamed' } as never);
    expect(subjectsFindOne).not.toHaveBeenCalled();

    // subject_id provided but nonexistent — must reject with 400.
    await expect(
      service.update('pkg-1', 'teacher-1', { subject_id: 'missing' } as never),
    ).rejects.toThrow(BadRequestException);
  });
});
