import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CourseChapter } from '../packages/entities/course-chapter.entity';
import { Book } from '../books/entities/book.entity';
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
  for (const m of [
    'where',
    'andWhere',
    'orderBy',
    'setParameter',
    'skip',
    'take',
    'innerJoin',
    'limit',
    'select',
    'addSelect',
    'addOrderBy',
    'groupBy',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.clone = jest.fn(() => b);
  b.getCount = jest.fn().mockResolvedValue(count);
  b.getMany = jest.fn().mockResolvedValue(many);
  b.getRawMany = jest.fn().mockResolvedValue(many);
  return b;
}

describe('SearchService', () => {
  let service: SearchService;
  const packages = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const lessons = { createQueryBuilder: jest.fn() };
  const books = { createQueryBuilder: jest.fn() };
  const users = { createQueryBuilder: jest.fn() };
  const subjects = { createQueryBuilder: jest.fn() };
  const chapters = { createQueryBuilder: jest.fn() };
  const searchLog = { createQueryBuilder: jest.fn(), insert: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: pg_trgm is installed — most tests exercise the ranked path.
    packages.query.mockResolvedValue([{ available: true }]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: getRepositoryToken(Lesson), useValue: lessons },
        { provide: getRepositoryToken(Book), useValue: books },
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
    expect(result).toEqual({
      courses: [],
      lessons: [],
      books: [],
      teachers: [],
      subjects: [],
      supportUsers: [],
    });
    expect(packages.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns no support-user results to unauthenticated and non-Call-Center searches', async () => {
    const result = await service.searchByType('ahmed', SearchType.SUPPORT_USERS, 1, 20, {
      userId: 'student-1',
      email: 'student@example.test',
      name: 'Student',
      role: 'student',
    });

    expect(result.data).toEqual([]);
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('limits support-user global search to Call Center agents and does not expose contact fields', async () => {
    const row = qb(1, [{ id: 'user-1', name: 'Ahmed Ali', role: 'student' }]);
    users.createQueryBuilder.mockReturnValue(row);

    const result = await service.searchByType('ahmed', SearchType.SUPPORT_USERS, 1, 20, {
      userId: 'agent-1',
      email: 'agent@example.test',
      name: 'Agent',
      role: 'call_center',
    });

    expect(result.data).toEqual([
      {
        type: 'support_user',
        id: 'user-1',
        title: 'Ahmed Ali',
        subtitle: 'Student',
        thumbnail: null,
        url: '/call-center/users/user-1',
      },
    ]);
    expect(row.andWhere).toHaveBeenCalledWith('u.role IN (:...roles)', {
      roles: ['student', 'teacher'],
    });
    expect(JSON.stringify(result.data)).not.toContain('email');
    expect(JSON.stringify(result.data)).not.toContain('phone');
  });

  it('returns books in the public catalog search results', async () => {
    const row = qb(1, [{ id: 'B1', title: 'Algebra workbook', cover_image: null }]);
    books.createQueryBuilder.mockReturnValue(row);

    const result = await service.searchByType('alg', SearchType.BOOKS, 1, 20);

    expect(result.data[0]).toEqual({
      type: 'book',
      id: 'B1',
      title: 'Algebra workbook',
      subtitle: null,
      thumbnail: null,
      url: '/shop/books/B1',
    });
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

  it('searches lesson titles through the normalized column without querying the nonexistent title_ar', async () => {
    const row = qb(1, [{ id: 'L1', title: 'Algebra lesson', thumbnail: null }]);
    lessons.createQueryBuilder.mockReturnValue(row);

    const result = await service.searchByType('alg', SearchType.LESSONS, 1, 20);

    expect(result.data[0]?.id).toBe('L1');
    expect(row.andWhere).toHaveBeenCalledWith(expect.stringContaining('l.search_text % :q'), {
      like: '%alg%',
      q: 'alg',
    });
    expect(row.andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('l.title_ar'),
      expect.anything(),
    );
  });

  it('does not throw if logging a query fails', async () => {
    searchLog.insert.mockRejectedValue(new Error('db down'));
    await expect(service.logQuery('algebra', 'u1')).resolves.toBeUndefined();
  });

  it('retrieves typo-tolerant candidates and orders them by normalized similarity when pg_trgm is installed', async () => {
    const row = qb(1, [{ id: 'P1', title: 'Algebra', category: 'Math', thumbnail: null }]);
    packages.createQueryBuilder.mockReturnValue(row);
    await service.searchByType('alg', SearchType.COURSES, 1, 20);
    expect(row.andWhere).toHaveBeenCalledWith(expect.stringContaining('pkg.search_text % :q'), {
      like: '%alg%',
      q: 'alg',
    });
    expect(row.orderBy).toHaveBeenCalledWith('similarity(pkg.search_text, :q)', 'DESC');
    expect(row.addOrderBy).toHaveBeenCalledWith('pkg.title', 'ASC');
  });

  it('falls back to plain ordering (no 500) when pg_trgm is not installed', async () => {
    packages.query.mockResolvedValue([{ available: false }]);
    const row = qb(1, [{ id: 'P1', title: 'Algebra', category: 'Math', thumbnail: null }]);
    packages.createQueryBuilder.mockReturnValue(row);

    const result = await service.searchByType('alg', SearchType.COURSES, 1, 20);

    expect(row.orderBy).toHaveBeenCalledWith('pkg.title', 'ASC');
    expect(row.orderBy).not.toHaveBeenCalledWith(
      expect.stringContaining('similarity('),
      expect.anything(),
    );
    expect(result.data[0]?.id).toBe('P1');
  });

  it('self-heals when similarity() throws "function does not exist" at query time', async () => {
    // Cache says pg_trgm is available, but the actual query fails with 42883
    // (e.g. the extension-creating migration hasn't finished applying yet).
    const row = qb(1, [{ id: 'P1', title: 'Algebra', category: 'Math', thumbnail: null }]);
    row.getMany
      .mockRejectedValueOnce(
        Object.assign(new Error('function similarity(character varying, unknown) does not exist'), {
          code: '42883',
        }),
      )
      .mockResolvedValueOnce([{ id: 'P1', title: 'Algebra', category: 'Math', thumbnail: null }]);
    packages.createQueryBuilder.mockReturnValue(row);

    const result = await service.searchByType('alg', SearchType.COURSES, 1, 20);

    expect(result.data[0]?.id).toBe('P1');
    // First attempt used similarity, retry used the plain fallback.
    expect(row.orderBy).toHaveBeenCalledWith('similarity(pkg.search_text, :q)', 'DESC');
    expect(row.orderBy).toHaveBeenCalledWith('pkg.title', 'ASC');
  });

  it('propagates non-undefined-function errors instead of masking them', async () => {
    const row = qb(1, []);
    row.getMany.mockRejectedValue(new Error('connection terminated'));
    packages.createQueryBuilder.mockReturnValue(row);

    await expect(service.searchByType('alg', SearchType.COURSES, 1, 20)).rejects.toThrow(
      'connection terminated',
    );
  });

  it('handles an in-course search when pg_trgm availability check itself fails', async () => {
    packages.query.mockRejectedValue(new Error('db unreachable'));
    const row = qb(0, []);
    lessons.createQueryBuilder.mockReturnValue(row);
    chapters.createQueryBuilder.mockReturnValue(qb(0, []));

    const result = await service.searchInCourse('pkg-1', 'algebra');

    expect(result).toEqual({ lessons: [], chapters: [] });
    expect(row.andWhere).toHaveBeenCalledWith("l.search_text LIKE :like ESCAPE '\\'", {
      like: '%algebra%',
    });
    expect(row.orderBy).toHaveBeenCalledWith('l.title', 'ASC');
  });

  it('only searches published active course curriculum', async () => {
    const lessonRows = qb(0, []);
    const chapterRows = qb(0, []);
    lessons.createQueryBuilder.mockReturnValue(lessonRows);
    chapters.createQueryBuilder.mockReturnValue(chapterRows);

    await service.searchInCourse('pkg-1', 'algebra');

    expect(lessonRows.andWhere).toHaveBeenCalledWith('pkg.deleted_at IS NULL');
    expect(lessonRows.andWhere).toHaveBeenCalledWith('pkg.is_active = true');
    expect(lessonRows.andWhere).toHaveBeenCalledWith('pkg.status = :packageStatus', {
      packageStatus: 'published',
    });
    expect(lessonRows.andWhere).toHaveBeenCalledWith('l.status = :lessonStatus', {
      lessonStatus: 'published',
    });
    expect(chapterRows.andWhere).toHaveBeenCalledWith('c.deleted_at IS NULL');
    expect(chapterRows.andWhere).toHaveBeenCalledWith('pkg.status = :packageStatus', {
      packageStatus: 'published',
    });
  });

  it('limits global subject results to approved, non-deleted subjects', async () => {
    const row = qb(0, []);
    subjects.createQueryBuilder.mockReturnValue(row);

    await service.searchByType('math', SearchType.SUBJECTS, 1, 20);

    expect(row.where).toHaveBeenCalledWith('s.deleted_at IS NULL');
    expect(row.andWhere).toHaveBeenCalledWith('s.status = :status', { status: 'approved' });
    expect(row.andWhere).toHaveBeenCalledWith(expect.stringContaining('s.search_text % :q'), {
      like: '%math%',
      q: 'math',
    });
  });

  it('keeps two-character queries on literal substring search to avoid noisy trigram matches', async () => {
    const row = qb(0, []);
    packages.createQueryBuilder.mockReturnValue(row);

    await service.searchByType('al', SearchType.COURSES, 1, 20);

    expect(row.andWhere).toHaveBeenCalledWith("pkg.search_text LIKE :like ESCAPE '\\'", {
      like: '%al%',
    });
    expect(row.orderBy).toHaveBeenCalledWith('pkg.title', 'ASC');
  });

  it('treats LIKE metacharacters in a user query as literal characters', async () => {
    const row = qb(0, []);
    packages.createQueryBuilder.mockReturnValue(row);

    await service.searchByType('100%', SearchType.COURSES, 1, 20);

    expect(row.andWhere).toHaveBeenCalledWith(expect.stringContaining('pkg.search_text % :q'), {
      like: '%100\\%%',
      q: '100%',
    });
  });

  it('returns the most recently searched distinct queries first', async () => {
    const row = qb(0, [{ query: 'algebra' }]);
    searchLog.createQueryBuilder.mockReturnValue(row);

    await expect(service.getRecent('user-1')).resolves.toEqual(['algebra']);

    expect(row.addSelect).toHaveBeenCalledWith('MAX(s.created_at)', 'last_searched_at');
    expect(row.groupBy).toHaveBeenCalledWith('s.query');
    expect(row.orderBy).toHaveBeenCalledWith('MAX(s.created_at)', 'DESC');
  });
});
