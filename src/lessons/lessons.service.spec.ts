import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/services/payments.service';
import type { Subject } from '../subjects/entities/subject.entity';
import type { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { BunnyStreamService } from './bunny-stream.service';
import { Lesson } from './entities/lesson.entity';
import { LessonStatus } from './entities/lesson-status.enum';
import { LessonsService } from './lessons.service';

function chainBuilder(methods: string[]): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {};
  for (const method of methods) {
    builder[method] = jest.fn(() => builder);
  }
  return builder;
}

describe('LessonsService.findAll', () => {
  const countQuery = { getCount: jest.fn() };
  const pageQuery = chainBuilder(['select', 'orderBy', 'addOrderBy', 'offset', 'limit']);
  const baseQuery = chainBuilder(['where', 'andWhere']);
  const listQuery = chainBuilder([
    'leftJoin',
    'leftJoinAndSelect',
    'select',
    'addSelect',
    'where',
    'setParameters',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'getMany',
  ]);
  const repository = { createQueryBuilder: jest.fn() };
  const media = {
    canonicalPublicReference: jest.fn((value: string | null) => value),
    normalizeStoredPublicReference: jest.fn((value: string) => value),
    resolveThumbnailUrl: jest.fn(),
  };

  let service: LessonsService;

  beforeEach(() => {
    jest.clearAllMocks();
    baseQuery.clone = jest.fn().mockReturnValueOnce(countQuery).mockReturnValueOnce(pageQuery);
    pageQuery.getQuery = jest.fn().mockReturnValue('SELECT lesson.id FROM lessons lesson');
    pageQuery.getParameters = jest.fn().mockReturnValue({});
    listQuery.getRawMany = jest.fn();
    repository.createQueryBuilder.mockReturnValueOnce(baseQuery).mockReturnValueOnce(listQuery);
    media.resolveThumbnailUrl.mockReturnValue('/media/thumbnail.jpg');

    service = new LessonsService(
      repository as unknown as Repository<Lesson>,
      {} as Repository<User>,
      {} as Repository<Subject>,
      {} as Repository<
        import('./entities/lesson-video-upload-session.entity').LessonVideoUploadSession
      >,
      {} as BunnyStreamService,
      {} as PaymentsService,
      media as unknown as MediaService,
      {} as never,
      {} as never,
      {} as never,
      { getLessonStudentCounts: jest.fn().mockResolvedValue(new Map()) } as never,
      {} as never,
    );
  });

  it('selects a deep page before joining and explicitly projects response fields', async () => {
    countQuery.getCount.mockResolvedValue(10_000);
    listQuery.getRawMany.mockResolvedValue([
      {
        id: 'lesson-1',
        title: 'Algebra',
        description: 'Description',
        teacher_id: 'teacher-1',
        teacher_name: 'Teacher',
        teacher_email: 'teacher@example.com',
        teacher_profile_picture_url: null,
        subject_id: 'subject-1',
        subject_name: 'Math',
        thumbnail: 'thumbnail.jpg',
        video_url: null,
        video_platform: 'bunny',
        bunny_video_id: null,
        bunny_library_id: null,
        bunny_video_status: null,
        video_width: null,
        video_height: null,
        video_thumbnail: null,
        video_size_bytes: '4096',
        price: '125.50',
        duration: 120,
        is_group: false,
        available_for_days: 7,
        students_count: 20,
        status: LessonStatus.PUBLISHED,
        created_at: '2026-07-14T12:00:00.000Z',
        updated_at: '2026-07-14T12:00:00.000Z',
      },
    ]);

    const result = await service.findAll({ page: 500, limit: 20 });

    expect(countQuery.getCount).toHaveBeenCalledTimes(1);
    expect(listQuery.getRawMany).toHaveBeenCalledTimes(1);
    expect(pageQuery.offset).toHaveBeenCalledWith(9_980);
    expect(pageQuery.limit).toHaveBeenCalledWith(20);
    expect(listQuery.where).toHaveBeenCalledWith(
      'lesson.id IN (SELECT lesson.id FROM lessons lesson)',
    );
    expect(listQuery.leftJoin).toHaveBeenCalledWith('lesson.teacher', 'teacher');
    expect(listQuery.leftJoin).toHaveBeenCalledWith('lesson.subject', 'subject');
    expect(listQuery.leftJoinAndSelect).not.toHaveBeenCalled();
    expect(listQuery.getMany).not.toHaveBeenCalled();
    expect(listQuery.skip).not.toHaveBeenCalled();
    expect(listQuery.take).not.toHaveBeenCalled();

    const selectedExpressions = listQuery.addSelect.mock.calls.map(
      ([expression]) => expression as string,
    );
    expect(selectedExpressions).toContain('teacher.name');
    expect(selectedExpressions).toContain('subject.name');
    expect(selectedExpressions).not.toContain('teacher.password_hash');
    expect(result.meta).toEqual({
      total: 10_000,
      page: 500,
      limit: 20,
      totalPages: 500,
      hasNextPage: false,
      hasPrevPage: true,
    });
    expect(result.data[0]).toMatchObject({
      id: 'lesson-1',
      title: 'Algebra',
      price: 125.5,
      video_size_bytes: 4096,
      thumbnail_url: '/media/thumbnail.jpg',
      teacher: { id: 'teacher-1', name: 'Teacher' },
      subject: { id: 'subject-1', name: 'Math' },
    });
  });

  it('applies filters to both count and page-id selection before cloning', async () => {
    countQuery.getCount.mockResolvedValue(0);
    listQuery.getRawMany.mockResolvedValue([]);

    await service.findAll({
      page: 2,
      limit: 25,
      teacher_id: 'teacher-1',
      subject_id: 'subject-1',
      search: 'algebra',
    });

    expect(baseQuery.andWhere).toHaveBeenCalledWith('lesson.teacher_id = :teacherId', {
      teacherId: 'teacher-1',
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('lesson.subject_id = :subjectId', {
      subjectId: 'subject-1',
    });
    expect(pageQuery.offset).toHaveBeenCalledWith(25);
  });
});

describe('LessonsService lesson duration persistence', () => {
  const teacher = {
    id: 'teacher-1',
    role: UserRole.TEACHER,
    name: 'Teacher',
    profile_picture_url: null,
  } as User;
  const subject = {
    id: 'subject-1',
    name: 'Mathematics',
  } as Subject;

  const lesson = {
    id: 'lesson-1',
    title: 'Algebra lesson',
    description: null,
    teacher_id: teacher.id,
    teacher,
    subject_id: subject.id,
    subject,
    thumbnail: null,
    video_url: null,
    video_platform: 'bunny',
    bunny_video_id: null,
    bunny_library_id: null,
    bunny_video_status: null,
    video_width: null,
    video_height: null,
    video_thumbnail: null,
    video_size_bytes: null,
    price: 0,
    duration: null,
    is_group: false,
    is_free_preview: false,
    available_for_days: 7,
    students_count: 0,
    status: LessonStatus.PUBLISHED,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  } as Lesson;

  const lessonRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const usersRepository = { findOne: jest.fn() };
  const subjectsRepository = { findOne: jest.fn() };
  const bunny = {
    getVideo: jest.fn(),
    generateSignedEmbedUrl: jest.fn(),
  };
  const payments = { hasLessonPlaybackAccess: jest.fn() };
  const media = {
    canonicalPublicReference: jest.fn((value: string | null) => value),
    normalizeStoredPublicReference: jest.fn((value: string) => value),
    resolveThumbnailUrl: jest.fn().mockReturnValue(null),
  };
  const lessonSessions = { createManyWithManager: jest.fn() };
  const dataSource = {
    transaction: jest.fn(async (callback: (manager: { save: jest.Mock }) => Promise<Lesson>) =>
      callback({ save: jest.fn(async (_entity: unknown, value: Lesson) => lessonRepository.save(value)) }),
    ),
    query: jest.fn().mockResolvedValue([{ exists: false }]),
  };
  let service: LessonsService;

  beforeEach(() => {
    jest.clearAllMocks();
    lesson.duration = null;
    lesson.bunny_video_id = null;
    lesson.bunny_video_status = null;
    lesson.video_thumbnail = null;
    lesson.is_free_preview = false;
    lessonRepository.create.mockImplementation((value: Partial<Lesson>) => ({
      ...lesson,
      ...value,
    }));
    lessonRepository.save.mockImplementation(async (value: Lesson) => value);
    lessonRepository.findOne.mockResolvedValue(lesson);
    usersRepository.findOne.mockResolvedValue(teacher);
    subjectsRepository.findOne.mockResolvedValue(subject);
    service = new LessonsService(
      lessonRepository as unknown as Repository<Lesson>,
      usersRepository as unknown as Repository<User>,
      subjectsRepository as unknown as Repository<Subject>,
      {} as Repository<
        import('./entities/lesson-video-upload-session.entity').LessonVideoUploadSession
      >,
      bunny as unknown as BunnyStreamService,
      payments as unknown as PaymentsService,
      media as unknown as MediaService,
      lessonSessions as never,
      dataSource as never,
      {} as never,
      // The student count is a live lesson_purchases aggregate now, not the
      // dead `lesson.students_count` column, so the mapper needs the metrics
      // service even on paths that only assert on duration/thumbnail.
      { getLessonStudentCounts: jest.fn().mockResolvedValue(new Map()) } as never,
      {} as never,
    );
  });

  it('keeps Group lesson creation valid without a session duration', async () => {
    const result = await service.create(teacher.id, {
      title: lesson.title,
      subject_id: subject.id,
      price: 0,
      is_group: true,
    });

    expect(lessonRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ duration: null }),
    );
    expect(lessonRepository.save).toHaveBeenCalledWith(expect.objectContaining({ duration: null }));
    expect(result.duration).toBeNull();
  });

  it('persists a supplied duration in seconds on create', async () => {
    await service.create(teacher.id, {
      title: lesson.title,
      subject_id: subject.id,
      price: 0,
      duration: 3_600,
      is_group: false,
    });

    expect(lessonRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 3_600 }),
    );
    expect(lessonRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 3_600 }),
    );
  });

  it('stores an uploaded thumbnail as a provider-neutral key', async () => {
    media.normalizeStoredPublicReference.mockReturnValue('images/cover.jpg');

    await service.create(teacher.id, {
      title: lesson.title,
      subject_id: subject.id,
      price: 0,
      is_group: true,
      thumbnail: 'http://localhost:3001/api/v1/media/public/images/cover.jpg',
    });

    expect(media.normalizeStoredPublicReference).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/media/public/images/cover.jpg',
    );
    expect(lessonRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnail: 'images/cover.jpg' }),
    );
  });

  it('persists a valid duration update using the same seconds-based field', async () => {
    const result = await service.update(lesson.id, teacher.id, { duration: 1_800 });

    expect(lesson.duration).toBe(1_800);
    expect(lessonRepository.save).toHaveBeenCalledWith(lesson);
    expect(result.duration).toBe(1_800);
  });

  it('persists the Bunny-generated video poster after encoding metadata is available', async () => {
    lesson.bunny_video_id = 'bunny-video-1';
    bunny.getVideo.mockResolvedValue({
      status: 'ready',
      progress: 100,
      durationSeconds: 120,
      width: 1920,
      height: 1080,
      sizeBytes: 4096,
      thumbnailUrl: 'https://cdn.example.test/bunny-video-1/thumbnail.jpg',
    });

    await service.refreshBunnyStatus(lesson.id, teacher.id);

    expect(lesson.video_thumbnail).toBe('https://cdn.example.test/bunny-video-1/thumbnail.jpg');
    expect(lessonRepository.save).toHaveBeenCalledWith(lesson);
  });

  it('denies a non-entitled viewer before asking Bunny to sign playback', async () => {
    lesson.bunny_video_id = 'bunny-video-1';
    lesson.bunny_video_status = 'ready';
    payments.hasLessonPlaybackAccess.mockResolvedValue(false);

    await expect(
      service.getSignedPlaybackUrl(lesson.id, 'student-without-access', UserRole.STUDENT),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(bunny.generateSignedEmbedUrl).not.toHaveBeenCalled();
  });
});
