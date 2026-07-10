import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CourseChapter } from '../packages/entities/course-chapter.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { SearchQueryLog } from './entities/search-query.entity';
import { SearchType } from './dto/search.dto';
import { SearchService } from './search.service';

/** QB whose count/getMany resolve to the provided values; clone() returns self. */
function qb(count: number, many: unknown[]) {
  const b: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'setParameter', 'skip', 'take', 'innerJoin', 'limit', 'select', 'addSelect', 'groupBy']) {
    b[m] = jest.fn(() => b);
  }
  b.clone = jest.fn(() => b);
  b.getCount = jest.fn().mockResolvedValue(count);
  b.getMany = jest.fn().mockResolvedValue(many);
  return b;
}

describe('SearchService', () => {
  let service: SearchService;
  const packages = { createQueryBuilder: jest.fn() };
  const lessons = { createQueryBuilder: jest.fn() };
  const users = { createQueryBuilder: jest.fn() };
  const subjects = { createQueryBuilder: jest.fn() };
  const chapters = { createQueryBuilder: jest.fn() };
  const searchLog = { createQueryBuilder: jest.fn(), insert: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: getRepositoryToken(Lesson), useValue: lessons },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Subject), useValue: subjects },
        { provide: getRepositoryToken(CourseChapter), useValue: chapters },
        { provide: getRepositoryToken(SearchQueryLog), useValue: searchLog },
      ],
    }).compile();
    service = module.get(SearchService);
  });

  it('returns empty groups for a query shorter than 2 chars (no DB hit)', async () => {
    const result = await service.searchAll('a');
    expect(result).toEqual({ courses: [], lessons: [], teachers: [], subjects: [] });
    expect(packages.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('maps course rows to search result items with a course URL', async () => {
    packages.createQueryBuilder.mockReturnValue(
      qb(1, [{ id: 'P1', title: 'Algebra', category: 'Math', thumbnail: null }]),
    );
    const result = await service.searchByType('alg', SearchType.COURSES, 1, 20);
    expect(result.meta.total).toBe(1);
    expect(result.data[0]).toEqual({
      type: 'course',
      id: 'P1',
      title: 'Algebra',
      subtitle: 'Math',
      thumbnail: null,
      url: '/courses/P1',
    });
  });

  it('does not throw if logging a query fails', async () => {
    searchLog.insert.mockRejectedValue(new Error('db down'));
    await expect(service.logQuery('algebra', 'u1')).resolves.toBeUndefined();
  });
});
