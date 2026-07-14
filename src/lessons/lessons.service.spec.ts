import type { Repository } from 'typeorm';

import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/services/payments.service';
import type { Subject } from '../subjects/entities/subject.entity';
import type { User } from '../users/entities/user.entity';
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
  const media = { resolveThumbnailUrl: jest.fn() };

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
      {} as BunnyStreamService,
      {} as PaymentsService,
      media as unknown as MediaService,
    );
  });

  it('selects a deep page before joining and explicitly projects response fields', async () => {
    countQuery.getCount.mockResolvedValue(10_000);
    listQuery.getRawMany.mockResolvedValue([
      {
        id: 'lesson-1',
        title: 'Algebra',
        title_ar: 'Algebra AR',
        description: 'Description',
        description_ar: null,
        teacher_id: 'teacher-1',
        teacher_name: 'Teacher',
        teacher_email: 'teacher@example.com',
        teacher_profile_picture_url: null,
        subject_id: 'subject-1',
        subject_name: 'Math',
        subject_grade_level: '10',
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
        vimeo_video_id: null,
        vimeo_embed_url: null,
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
