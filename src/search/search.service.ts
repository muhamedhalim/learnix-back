import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Repository } from 'typeorm';

import { normalizeArabicQuery } from '../common/utils/arabic-search.util';
import { CourseStatus } from '../packages/entities/course-status.enum';
import { Book } from '../books/entities/book.entity';
import { CourseChapter } from '../packages/entities/course-chapter.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonStatus } from '../lessons/entities/lesson-status.enum';
import { Subject } from '../subjects/entities/subject.entity';
import { SubjectStatus } from '../subjects/entities/subject-status.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { SearchQueryLog } from './entities/search-query.entity';
import { SearchType } from './dto/search.dto';

export interface SearchResultItem {
  type: 'course' | 'lesson' | 'book' | 'teacher' | 'subject' | 'support_user';
  id: string;
  title: string;
  subtitle: string | null;
  thumbnail: string | null;
  url: string;
}

interface PaginatedResults {
  data: SearchResultItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

const UNDEFINED_FUNCTION = '42883';
/** Re-probe pg_trgm periodically so the fallback self-heals once a pending
 *  migration finally runs, without requiring an app restart. */
const TRGM_RECHECK_MS = 5 * 60 * 1000;
/** Trigram similarity is too broad for one- and two-character queries. */
const MIN_FUZZY_QUERY_LENGTH = 3;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  /** Cached pg_trgm availability. `null` = not checked yet. */
  private trgmAvailable: boolean | null = null;
  private trgmCheckedAt = 0;

  constructor(
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    @InjectRepository(CourseChapter)
    private readonly chaptersRepository: Repository<CourseChapter>,
    @InjectRepository(SearchQueryLog)
    private readonly searchLogRepository: Repository<SearchQueryLog>,
  ) {}

  private normalize(q: string): string {
    return normalizeArabicQuery(q);
  }

  /** Grouped overview across all surfaces (limited per group) — for the dropdown. */
  public async searchAll(
    rawQuery: string,
    actor?: JwtPayload,
  ): Promise<{
    courses: SearchResultItem[];
    lessons: SearchResultItem[];
    books: SearchResultItem[];
    teachers: SearchResultItem[];
    subjects: SearchResultItem[];
    supportUsers: SearchResultItem[];
  }> {
    const q = this.normalize(rawQuery);
    if (q.length < 2) {
      return { courses: [], lessons: [], books: [], teachers: [], subjects: [], supportUsers: [] };
    }
    const [courses, lessons, books, teachers, subjects, supportUsers] = await Promise.all([
      this.searchCourses(q, 1, 5),
      this.searchLessons(q, 1, 5),
      this.searchBooks(q, 1, 5),
      this.searchTeachers(q, 1, 5),
      this.searchSubjects(q, 1, 5),
      this.canSearchSupportUsers(actor)
        ? this.searchSupportUsers(q, 1, 5)
        : Promise.resolve({ data: [] as SearchResultItem[], meta: this.emptyMeta(1, 5) }),
    ]);
    return {
      courses: courses.data,
      lessons: lessons.data,
      books: books.data,
      teachers: teachers.data,
      subjects: subjects.data,
      supportUsers: supportUsers.data,
    };
  }

  /** Paginated single-type search. */
  public async searchByType(
    rawQuery: string,
    type: SearchType,
    page: number,
    limit: number,
    actor?: JwtPayload,
  ): Promise<PaginatedResults> {
    const q = this.normalize(rawQuery);
    if (q.length < 2) {
      return { data: [], meta: { page, limit, total: 0, totalPages: 0 } };
    }
    switch (type) {
      case SearchType.COURSES:
        return this.searchCourses(q, page, limit);
      case SearchType.LESSONS:
        return this.searchLessons(q, page, limit);
      case SearchType.BOOKS:
        return this.searchBooks(q, page, limit);
      case SearchType.TEACHERS:
        return this.searchTeachers(q, page, limit);
      case SearchType.SUBJECTS:
        return this.searchSubjects(q, page, limit);
      case SearchType.SUPPORT_USERS:
        return this.canSearchSupportUsers(actor)
          ? this.searchSupportUsers(q, page, limit)
          : { data: [], meta: this.emptyMeta(page, limit) };
      default:
        return this.searchCourses(q, page, limit);
    }
  }

  /**
   * Public curriculum search. A package must be published and active, and a
   * lesson/chapter must be public itself before any metadata can be returned.
   */
  public async searchInCourse(
    packageId: string,
    rawQuery: string,
  ): Promise<{
    lessons: SearchResultItem[];
    chapters: { id: string; title: string }[];
  }> {
    const q = this.normalize(rawQuery);
    if (q.length < 2) {
      return { lessons: [], chapters: [] };
    }
    const baseLessons = (includeFuzzy: boolean): SelectQueryBuilder<Lesson> => {
      const query = this.lessonsRepository
        .createQueryBuilder('l')
        .innerJoin('lesson_package_items', 'lpi', 'lpi.lesson_id = l.id')
        .innerJoin(LessonPackage, 'pkg', 'pkg.id = lpi.package_id')
        .where('lpi.package_id = :packageId', { packageId })
        .andWhere('pkg.deleted_at IS NULL')
        .andWhere('pkg.is_active = true')
        .andWhere('pkg.status = :packageStatus', { packageStatus: CourseStatus.PUBLISHED })
        .andWhere('l.deleted_at IS NULL')
        .andWhere('l.status = :lessonStatus', { lessonStatus: LessonStatus.PUBLISHED });
      // `lessons` has a single `title` column. Unlike packages and chapters,
      // it has never had a `title_ar` column, so querying it makes catalogue
      // search fail against the production schema.
      return this.applySearchFilter(query, 'l.search_text', q, includeFuzzy);
    };

    const lessons = await this.safeGetMany((useSimilarity) => {
      const includeFuzzy = this.shouldUseFuzzy(q, useSimilarity);
      return this.applySearchOrder(
        baseLessons(includeFuzzy).limit(20),
        'l.search_text',
        'l.title',
        q,
        includeFuzzy,
      );
    });

    const chapters = await this.safeGetMany((useSimilarity) => {
      const includeFuzzy = this.shouldUseFuzzy(q, useSimilarity);
      const query = this.chaptersRepository
        .createQueryBuilder('c')
        .innerJoin('c.package', 'pkg')
        .where('c.package_id = :packageId', { packageId })
        .andWhere('c.deleted_at IS NULL')
        .andWhere('pkg.deleted_at IS NULL')
        .andWhere('pkg.is_active = true')
        .andWhere('pkg.status = :packageStatus', { packageStatus: CourseStatus.PUBLISHED });
      return this.applySearchOrder(
        this.applySearchFilter(query, 'c.search_text', q, includeFuzzy).limit(20),
        'c.search_text',
        'c.title',
        q,
        includeFuzzy,
      );
    });

    return {
      lessons: lessons.map((l) => this.lessonItem(l)),
      chapters: chapters.map((c) => ({ id: c.id, title: c.title })),
    };
  }

  /* ===================== Recent / popular ===================== */

  /** Best-effort log of a performed search (never throws to the caller). */
  public async logQuery(rawQuery: string, userId?: string): Promise<void> {
    const q = this.normalize(rawQuery).toLowerCase();
    if (q.length < 2) return;
    try {
      await this.searchLogRepository.insert({
        query: q.slice(0, 200),
        user_id: userId ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to log search query: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  public async getRecent(userId: string, limit = 8): Promise<string[]> {
    const rows = await this.searchLogRepository
      .createQueryBuilder('s')
      .select('s.query', 'query')
      .addSelect('MAX(s.created_at)', 'last_searched_at')
      .where('s.user_id = :userId', { userId })
      .groupBy('s.query')
      .orderBy('MAX(s.created_at)', 'DESC')
      .limit(limit)
      .getRawMany<{ query: string }>();
    return rows.map((r) => r.query);
  }

  /* ===================== pg_trgm availability guard ===================== */

  /**
   * Whether `similarity()` (pg_trgm) can be used for relevance ranking on this
   * database. Cached with a short TTL so the search system self-heals once a
   * pending migration installs the extension, without requiring a restart —
   * and so a missing extension never turns into a per-request DB round trip.
   */
  private async isTrgmAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.trgmAvailable !== null && now - this.trgmCheckedAt < TRGM_RECHECK_MS) {
      return this.trgmAvailable;
    }
    try {
      const rows = (await this.packagesRepository.query(
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS available`,
      )) as { available: boolean }[];
      this.trgmAvailable = rows[0]?.available === true;
    } catch (error) {
      this.logger.warn(
        `Failed to check pg_trgm availability, assuming unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      this.trgmAvailable = false;
    }
    this.trgmCheckedAt = now;
    return this.trgmAvailable;
  }

  /** True when the error is Postgres' "function does not exist" (undefined_function). */
  private isUndefinedFunctionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const e = error as { code?: string; driverError?: { code?: string } };
    const code = e.code ?? e.driverError?.code;
    return code === UNDEFINED_FUNCTION;
  }

  /**
   * Runs a query built with (or without) trigram retrieval and relevance
   * ordering. Falls back to a plain, already-LIKE-filtered ordering — instead of a 500
   * — when pg_trgm isn't installed, and self-heals the cached flag if the
   * function turns out to be missing only at query time (e.g. a migration
   * that hasn't finished applying yet).
   */
  private async safeGetMany<T extends ObjectLiteral>(
    build: (useSimilarity: boolean) => SelectQueryBuilder<T>,
  ): Promise<T[]> {
    const useSimilarity = await this.isTrgmAvailable();
    try {
      return await build(useSimilarity).getMany();
    } catch (error) {
      if (useSimilarity && this.isUndefinedFunctionError(error)) {
        this.trgmAvailable = false;
        this.trgmCheckedAt = Date.now();
        this.logger.warn(
          'pg_trgm similarity() is unavailable — falling back to unranked search ordering. Run pending migrations to restore relevance ranking.',
        );
        return await build(false).getMany();
      }
      throw error;
    }
  }

  /** Escapes SQL LIKE metacharacters so a literal user query stays literal. */
  private likePattern(q: string, prefix = false): string {
    const escaped = q.replace(/[\\%_]/g, '\\$&');
    return prefix ? `${escaped}%` : `%${escaped}%`;
  }

  private shouldUseFuzzy(q: string, trgmAvailable: boolean): boolean {
    return trgmAvailable && q.length >= MIN_FUZZY_QUERY_LENGTH;
  }

  /** Call Center results use the same student/teacher-only scope as `/callcenter/users`. */
  private canSearchSupportUsers(actor?: JwtPayload): boolean {
    return actor?.role === UserRole.CALL_CENTER;
  }

  private emptyMeta(page: number, limit: number): PaginatedResults['meta'] {
    return { page, limit, total: 0, totalPages: 0 };
  }

  /**
   * Keeps substring search available for all supported database states, then
   * adds pg_trgm's `%` operator when it is both installed and useful. `%`
   * performs candidate retrieval (not merely ranking) and can use the Phase 2
   * GIN trigram indexes.
   */
  private applySearchFilter<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    column: string,
    q: string,
    includeFuzzy: boolean,
  ): SelectQueryBuilder<T> {
    const like = this.likePattern(q);
    if (includeFuzzy) {
      return query.andWhere(`(${column} LIKE :like ESCAPE '\\' OR ${column} % :q)`, {
        like,
        q,
      });
    }
    return query.andWhere(`${column} LIKE :like ESCAPE '\\'`, { like });
  }

  /** Prioritizes the normalized match score before using the display title as a stable tie-breaker. */
  private applySearchOrder<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    searchColumn: string,
    displayColumn: string,
    q: string,
    includeFuzzy: boolean,
  ): SelectQueryBuilder<T> {
    if (includeFuzzy) {
      return query
        .orderBy(`similarity(${searchColumn}, :q)`, 'DESC')
        .addOrderBy(displayColumn, 'ASC')
        .setParameter('q', q);
    }
    return query.orderBy(displayColumn, 'ASC');
  }

  private async getSearchPage<T extends ObjectLiteral>(
    q: string,
    page: number,
    limit: number,
    buildBase: (includeFuzzy: boolean) => SelectQueryBuilder<T>,
    searchColumn: string,
    displayColumn: string,
  ): Promise<{ rows: T[]; total: number }> {
    const trgmAvailable = await this.isTrgmAvailable();
    const execute = async (includeFuzzy: boolean): Promise<{ rows: T[]; total: number }> => {
      const total = await buildBase(includeFuzzy).getCount();
      const rows = await this.applySearchOrder(
        buildBase(includeFuzzy)
          .skip((page - 1) * limit)
          .take(limit),
        searchColumn,
        displayColumn,
        q,
        includeFuzzy,
      ).getMany();
      return { rows, total };
    };

    const includeFuzzy = this.shouldUseFuzzy(q, trgmAvailable);
    try {
      return await execute(includeFuzzy);
    } catch (error) {
      if (includeFuzzy && this.isUndefinedFunctionError(error)) {
        this.trgmAvailable = false;
        this.trgmCheckedAt = Date.now();
        this.logger.warn(
          'pg_trgm operators are unavailable — falling back to literal substring search. Run pending migrations to restore typo-tolerant search.',
        );
        return execute(false);
      }
      throw error;
    }
  }

  /* ===================== Per-surface queries ===================== */

  private async searchCourses(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<LessonPackage>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.packagesRepository
          .createQueryBuilder('pkg')
          .where('pkg.deleted_at IS NULL')
          .andWhere('pkg.status = :status', { status: CourseStatus.PUBLISHED });
        return this.applySearchFilter(query, 'pkg.search_text', q, includeFuzzy);
      },
      'pkg.search_text',
      'pkg.title',
    );

    return this.paginate(
      rows.map((p) => ({
        type: 'course' as const,
        id: p.id,
        title: p.title,
        subtitle: p.category ?? null,
        thumbnail: p.thumbnail,
        url: `/courses/${p.id}`,
      })),
      page,
      limit,
      total,
    );
  }

  private async searchLessons(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<Lesson>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.lessonsRepository
          .createQueryBuilder('l')
          .where('l.deleted_at IS NULL')
          .andWhere('l.status = :status', { status: LessonStatus.PUBLISHED });
        return this.applySearchFilter(query, 'l.search_text', q, includeFuzzy);
      },
      'l.search_text',
      'l.title',
    );

    return this.paginate(
      rows.map((l) => this.lessonItem(l)),
      page,
      limit,
      total,
    );
  }

  private async searchBooks(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<Book>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.booksRepository
          .createQueryBuilder('book')
          .where('book.deleted_at IS NULL');
        return this.applySearchFilter(query, 'book.search_text', q, includeFuzzy);
      },
      'book.search_text',
      'book.title',
    );
    return this.paginate(
      rows.map((book) => ({
        type: 'book' as const,
        id: book.id,
        title: book.title,
        subtitle: null,
        thumbnail: book.cover_image,
        url: `/shop/books/${book.id}`,
      })),
      page,
      limit,
      total,
    );
  }

  private async searchTeachers(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<User>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.usersRepository
          .createQueryBuilder('u')
          .where('u.role = :role', { role: UserRole.TEACHER })
          .andWhere('u.deleted_at IS NULL')
          .andWhere('u.is_active = true')
          .andWhere('u.status = :status', { status: UserStatus.APPROVED });
        return this.applySearchFilter(query, 'u.search_text', q, includeFuzzy);
      },
      'u.search_text',
      'u.name',
    );

    return this.paginate(
      rows.map((u) => ({
        type: 'teacher' as const,
        id: u.id,
        title: u.name,
        subtitle: 'Teacher',
        thumbnail: null,
        url: `/u/${u.username}`,
      })),
      page,
      limit,
      total,
    );
  }

  private async searchSubjects(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<Subject>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.subjectsRepository
          .createQueryBuilder('s')
          .where('s.deleted_at IS NULL')
          .andWhere('s.status = :status', { status: SubjectStatus.APPROVED });
        return this.applySearchFilter(query, 's.search_text', q, includeFuzzy);
      },
      's.search_text',
      's.name',
    );

    return this.paginate(
      rows.map((s) => ({
        type: 'subject' as const,
        id: String(s.id),
        title: s.name,
        subtitle: null,
        thumbnail: null,
        url: `/shop?subject=${String(s.id)}`,
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * A deliberately narrow internal group. It never returns contact fields and
   * is only reachable by Call Center users, whose domain endpoint already
   * exposes the same student/teacher support population.
   */
  private async searchSupportUsers(
    q: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResults> {
    const { rows, total } = await this.getSearchPage<User>(
      q,
      page,
      limit,
      (includeFuzzy) => {
        const query = this.usersRepository
          .createQueryBuilder('u')
          .where('u.deleted_at IS NULL')
          .andWhere('u.role IN (:...roles)', {
            roles: [UserRole.STUDENT, UserRole.TEACHER],
          });
        const like = this.likePattern(q);
        const nameMatch = includeFuzzy
          ? `(u.search_text LIKE :like ESCAPE '\\' OR u.search_text % :q)`
          : `u.search_text LIKE :like ESCAPE '\\'`;
        return query.andWhere(
          `(${nameMatch} OR u.email ILIKE :like ESCAPE '\\' OR u.phone ILIKE :like ESCAPE '\\' OR u.username ILIKE :like ESCAPE '\\')`,
          includeFuzzy ? { like, q } : { like },
        );
      },
      'u.search_text',
      'u.name',
    );

    return this.paginate(
      rows.map((u) => ({
        type: 'support_user' as const,
        id: u.id,
        title: u.name,
        subtitle: u.role === UserRole.STUDENT ? 'Student' : 'Teacher',
        thumbnail: null,
        url: `/call-center/users/${u.id}`,
      })),
      page,
      limit,
      total,
    );
  }

  private lessonItem(l: Lesson): SearchResultItem {
    return {
      type: 'lesson',
      id: String(l.id),
      title: l.title,
      subtitle: null,
      thumbnail: l.thumbnail,
      url: `/student/lessons/${String(l.id)}`,
    };
  }

  private paginate(
    data: SearchResultItem[],
    page: number,
    limit: number,
    total: number,
  ): PaginatedResults {
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
