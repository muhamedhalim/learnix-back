import { ForbiddenException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { MediaService } from '../media/media.service';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { CourseChapter } from './entities/course-chapter.entity';
import { CourseStatus } from './entities/course-status.enum';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';
import { PackagesService } from './packages.service';

function createService(packageTeacherId: string) {
  const packages = { findOne: jest.fn(), save: jest.fn() };
  const chapters = {
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    softRemove: jest.fn(),
  };
  const itemRepo = { update: jest.fn() };
  const chapterRepo = { update: jest.fn() };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === LessonPackageItem ? itemRepo : chapterRepo,
    ),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (transactionManager: typeof manager) => Promise<void>) =>
      work(manager),
    ),
  };
  packages.findOne.mockResolvedValue({
    id: 'package-1',
    teacher_id: packageTeacherId,
    status: CourseStatus.DRAFT,
    is_active: false,
    published_at: null,
  });

  const service = new PackagesService(
    packages as unknown as Repository<LessonPackage>,
    {} as Repository<LessonPackageItem>,
    chapters as unknown as Repository<CourseChapter>,
    {} as Repository<Lesson>,
    {} as Repository<User>,
    {} as Repository<Subject>,
    dataSource as unknown as DataSource,
    {} as MediaService,
  );
  return { service, packages, chapters, dataSource, itemRepo, chapterRepo };
}

describe('PackagesService chapter and publication mutation access', () => {
  it.each([
    [
      'createChapter',
      (service: PackagesService) =>
        service.createChapter('package-1', 'teacher-1', { title: 'Chapter' }),
    ],
    [
      'updateChapter',
      (service: PackagesService) =>
        service.updateChapter('package-1', 'chapter-1', 'teacher-1', { title: 'Chapter' }),
    ],
    [
      'deleteChapter',
      (service: PackagesService) => service.deleteChapter('package-1', 'chapter-1', 'teacher-1'),
    ],
    [
      'reorderCurriculum',
      (service: PackagesService) =>
        service.reorderCurriculum('package-1', 'teacher-1', { items: [] }),
    ],
    [
      'updateStatus',
      (service: PackagesService) =>
        service.updateStatus('package-1', 'teacher-1', CourseStatus.PUBLISHED),
    ],
  ])('rejects a non-owner before %s mutates a course', async (_method, invoke) => {
    const { service, chapters, dataSource, packages } = createService('teacher-2');

    await expect(invoke(service)).rejects.toBeInstanceOf(ForbiddenException);

    expect(chapters.create).not.toHaveBeenCalled();
    expect(chapters.save).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(packages.save).not.toHaveBeenCalled();
  });

  it('persists lesson and chapter ordering in the same transaction', async () => {
    const { service, chapters, dataSource, itemRepo, chapterRepo } = createService('teacher-1');
    chapters.count.mockResolvedValue(1);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'package-1' } as never);

    await service.reorderCurriculum('package-1', 'teacher-1', {
      items: [{ lesson_id: 'lesson-1', order_index: 3, chapter_id: 'chapter-1' }],
      chapters: [{ id: 'chapter-1', order_index: 2 }],
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(itemRepo.update).toHaveBeenCalledWith(
      { package_id: 'package-1', lesson_id: 'lesson-1' },
      { order_index: 3, chapter_id: 'chapter-1' },
    );
    expect(chapterRepo.update).toHaveBeenCalledWith(
      { id: 'chapter-1', package_id: 'package-1' },
      { order_index: 2 },
    );
  });
});
