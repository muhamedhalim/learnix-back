import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/services/payments.service';
import type { Subject } from '../subjects/entities/subject.entity';
import type { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
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
    'setParameter',
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
      {} as PaymentsService,
      media as unknown as MediaService,
      { getBookingCutoffMinutes: jest.fn().mockReturnValue(60) } as never,
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
        video_asset_id: null,
        video_status: null,
        video_width: null,
        video_height: null,
        video_thumbnail: null,
        video_size_bytes: '4096',
        price: '125.50',
        duration: 120,
        is_group: false,
        available_for_days: 7,
        students_count: 20,
        available_sessions_count: '3',
        next_session_at: '2026-07-15T09:00:00.000Z',
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
    video_asset_id: null,
    video_status: null,
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

  const availableSessionsQuery = chainBuilder(['select', 'addSelect', 'where', 'setParameter']);
  const lessonRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    // Chainable builder consumed by `getAvailableSessionsSummary` (called on
    // every `mapToLessonWithDetails`); defaults to "no bookable appointments"
    // so tests unrelated to Individual Lesson scheduling don't need to care.
    createQueryBuilder: jest.fn(() => availableSessionsQuery),
  };
  const usersRepository = { findOne: jest.fn() };
  const subjectsRepository = { findOne: jest.fn() };
  const awsVideo = {
    status: jest.fn(),
    playback: jest.fn(),
    detach: jest.fn(),
  };
  const payments = { hasLessonPlaybackAccess: jest.fn() };
  const media = {
    canonicalPublicReference: jest.fn((value: string | null) => value),
    normalizeStoredPublicReference: jest.fn((value: string) => value),
    resolveThumbnailUrl: jest.fn().mockReturnValue(null),
  };
  const lessonSessions = {
    createManyWithManager: jest.fn(),
    getBookingCutoffMinutes: jest.fn().mockReturnValue(60),
  };
  const dataSource = {
    transaction: jest.fn(async (callback: (manager: { save: jest.Mock }) => Promise<Lesson>) =>
      callback({
        save: jest.fn(async (_entity: unknown, value: Lesson) => lessonRepository.save(value)),
      }),
    ),
    query: jest.fn().mockResolvedValue([{ exists: false }]),
  };
  let service: LessonsService;

  beforeEach(() => {
    jest.clearAllMocks();
    lesson.duration = null;
    lesson.video_asset_id = null;
    lesson.video_status = null;
    lesson.video_thumbnail = null;
    lesson.is_free_preview = false;
    // Default: no bookable appointments. Individual-lesson-scheduling specs
    // override this per test.
    availableSessionsQuery.getRawOne = jest.fn().mockResolvedValue({ count: '0', next_at: null });
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
      awsVideo as never,
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

  it('reports the processing state of the lesson video through the AWS video service', async () => {
    lesson.video_asset_id = 'asset-1';
    awsVideo.status.mockResolvedValue({ lessonId: lesson.id, status: 'processing' });

    const result = await service.refreshVideoStatus(lesson.id, teacher.id);

    expect(awsVideo.status).toHaveBeenCalledWith(lesson.id, teacher.id);
    expect(result).toEqual({ lessonId: lesson.id, status: 'processing' });
  });

  it('answers 400 for a status request on a lesson without a video', async () => {
    await expect(service.refreshVideoStatus(lesson.id, teacher.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(awsVideo.status).not.toHaveBeenCalled();
  });

  it('removes the lesson video through the AWS video service, and is a no-op without one', async () => {
    await service.removeVideo(lesson.id, teacher.id);
    expect(awsVideo.detach).not.toHaveBeenCalled();

    lesson.video_asset_id = 'asset-1';
    await service.removeVideo(lesson.id, teacher.id);
    expect(awsVideo.detach).toHaveBeenCalledWith(lesson);
  });

  it('denies a non-entitled viewer before issuing a playback grant', async () => {
    lesson.video_asset_id = 'asset-1';
    lesson.video_status = 'ready';
    payments.hasLessonPlaybackAccess.mockResolvedValue(false);

    await expect(
      service.getSignedPlaybackUrl(lesson.id, 'student-without-access', UserRole.STUDENT),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(awsVideo.playback).not.toHaveBeenCalled();
  });

  it('refuses to publish a lesson whose video is still processing', async () => {
    lesson.video_asset_id = 'asset-1';
    lesson.video_status = 'processing';

    await expect(service.assertPublishable(lesson)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to publish an Individual Lesson with no future ready appointment (Phase 5.3)', async () => {
    lesson.is_group = false;
    availableSessionsQuery.getRawOne = jest.fn().mockResolvedValue({ count: '0', next_at: null });

    await expect(service.publishLesson(lesson.id, teacher.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(lessonRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: LessonStatus.PUBLISHED }),
    );
  });

  it('publishes an Individual Lesson once it has a bookable appointment', async () => {
    lesson.is_group = false;
    lesson.status = LessonStatus.DRAFT;
    availableSessionsQuery.getRawOne = jest
      .fn()
      .mockResolvedValue({ count: '1', next_at: '2026-02-01T10:00:00.000Z' });

    const result = await service.publishLesson(lesson.id, teacher.id);

    expect(result.status).toBe(LessonStatus.PUBLISHED);
    expect(lessonRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: LessonStatus.PUBLISHED }),
    );
  });

  it('publishes a Group lesson without requiring any bookable appointment', async () => {
    lesson.is_group = true;
    lesson.status = LessonStatus.DRAFT;
    availableSessionsQuery.getRawOne = jest.fn().mockResolvedValue({ count: '0', next_at: null });

    const result = await service.publishLesson(lesson.id, teacher.id);

    expect(result.status).toBe(LessonStatus.PUBLISHED);
  });
});
