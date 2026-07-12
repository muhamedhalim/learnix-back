import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Repository } from 'typeorm';

import { normalizeArabicQuery } from '../common/utils/arabic-search.util';
import { CourseStatus } from '../packages/entities/course-status.enum';
import { CourseChapter } from '../packages/entities/course-chapter.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonStatus } from '../lessons/entities/lesson-status.enum';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { SearchQueryLog } from './entities/search-query.entity';
import { SearchType } from './dto/search.dto';

export interface SearchResultItem {
  type: 'course' | 'lesson' | 'teacher' | 'subject';
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
  public async searchAll(rawQuery: string): Promise<{
    courses: SearchResultItem[];
    lessons: SearchResultItem[];
    teachers: SearchResultItem[];
    subjects: SearchResultItem[];
  }> {
    const q = this.normalize(rawQuery);
    if (q.length < 2) {
      return { courses: [], lessons: [], teachers: [], subjects: [] };
    }
    const [courses, lessons, teachers, subjects] = await Promise.all([
      this.searchCourses(q, 1, 5),
      this.searchLessons(q, 1, 5),
      this.searchTeachers(q, 1, 5),
      this.searchSubjects(q, 1, 5),
    ]);
    return {
      courses: courses.data,
      lessons: lessons.data,
      teachers: teachers.data,
      subjects: subjects.data,
    };
  }

  /** Paginated single-type search. */
  public async searchByType(
    rawQuery: string,
    type: SearchType,
    page: number,
    limit: number,
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
      case SearchType.TEACHERS:
        return this.searchTeachers(q, page, limit);
      case SearchType.SUBJECTS:
        return this.searchSubjects(q, page, limit);
      default:
        return this.searchCourses(q, page, limit);
    }
  }

  /** Lessons + chapters within a single published course. */
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
    const like = `%${q}%`;

    const baseLessons = (): SelectQueryBuilder<Lesson> =>
      this.lessonsRepository
        .createQueryBuilder('l')
        .innerJoin('lesson_package_items', 'lpi', 'lpi.lesson_id = l.id')
        .where('lpi.package_id = :packageId', { packageId })
        .andWhere('l.deleted_at IS NULL')
        .andWhere('(l.title ILIKE :like OR l.title_ar ILIKE :like)', { like });

    const lessons = await this.safeGetMany((useSimilarity) => {
      const qb = baseLessons().limit(20);
      return useSimilarity
        ? qb.orderBy('similarity(l.title, :q)', 'DESC').setParameter('q', q)
        : qb.orderBy('l.title', 'ASC');
    });

    const chapters = await this.chaptersRepository
      .createQueryBuilder('c')
      .where('c.package_id = :packageId', { packageId })
      .andWhere('(c.title ILIKE :like OR c.title_ar ILIKE :like)', { like })
      .limit(20)
      .getMany();

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

  public async getPopular(limit = 8): Promise<{ query: string; count: number }[]> {
    const rows = await this.searchLogRepository
      .createQueryBuilder('s')
      .select('s.query', 'query')
      .addSelect('COUNT(*)', 'count')
      .where("s.created_at >= NOW() - INTERVAL '30 days'")
      .groupBy('s.query')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany<{ query: string; count: string }>();
    return rows.map((r) => ({ query: r.query, count: Number.parseInt(r.count, 10) }));
  }

  public async getRecent(userId: string, limit = 8): Promise<string[]> {
    const rows = await this.searchLogRepository
      .createQueryBuilder('s')
      .select('DISTINCT ON (s.query) s.query', 'query')
      .addSelect('s.created_at', 'created_at')
      .where('s.user_id = :userId', { userId })
      .orderBy('s.query')
      .addOrderBy('s.created_at', 'DESC')
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
   * Runs a query built with (or without) `similarity()` relevance ordering.
   * Falls back to a plain, already-ILIKE-filtered ordering — instead of a 500
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

  /* ===================== Per-surface queries ===================== */

  private async searchCourses(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const like = `%${q}%`;
    const base = (): SelectQueryBuilder<LessonPackage> =>
      this.packagesRepository
        .createQueryBuilder('pkg')
        .where('pkg.deleted_at IS NULL')
        .andWhere('pkg.status = :status', { status: CourseStatus.PUBLISHED })
        .andWhere(
          '(pkg.title ILIKE :like OR pkg.title_ar ILIKE :like OR pkg.description ILIKE :like)',
          { like },
        );

    const total = await base().getCount();
    const rows = await this.safeGetMany((useSimilarity) => {
      const qb = base()
        .skip((page - 1) * limit)
        .take(limit);
      return useSimilarity
        ? qb.orderBy('similarity(pkg.title, :q)', 'DESC').setParameter('q', q)
        : qb.orderBy('pkg.title', 'ASC');
    });

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
    const like = `%${q}%`;
    const base = (): SelectQueryBuilder<Lesson> =>
      this.lessonsRepository
        .createQueryBuilder('l')
        .where('l.deleted_at IS NULL')
        .andWhere('l.status = :status', { status: LessonStatus.PUBLISHED })
        .andWhere('(l.title ILIKE :like OR l.title_ar ILIKE :like)', { like });

    const total = await base().getCount();
    const rows = await this.safeGetMany((useSimilarity) => {
      const qb = base()
        .skip((page - 1) * limit)
        .take(limit);
      return useSimilarity
        ? qb.orderBy('similarity(l.title, :q)', 'DESC').setParameter('q', q)
        : qb.orderBy('l.title', 'ASC');
    });

    return this.paginate(
      rows.map((l) => this.lessonItem(l)),
      page,
      limit,
      total,
    );
  }

  private async searchTeachers(q: string, page: number, limit: number): Promise<PaginatedResults> {
    const like = `%${q}%`;
    const base = (): SelectQueryBuilder<User> =>
      this.usersRepository
        .createQueryBuilder('u')
        .where('u.role = :role', { role: UserRole.TEACHER })
        .andWhere('u.is_active = true')
        .andWhere('u.status = :status', { status: UserStatus.APPROVED })
        .andWhere('u.name ILIKE :like', { like });

    const total = await base().getCount();
    const rows = await this.safeGetMany((useSimilarity) => {
      const qb = base()
        .skip((page - 1) * limit)
        .take(limit);
      return useSimilarity
        ? qb.orderBy('similarity(u.name, :q)', 'DESC').setParameter('q', q)
        : qb.orderBy('u.name', 'ASC');
    });

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
    const like = `%${q}%`;
    const base = (): SelectQueryBuilder<Subject> =>
      this.subjectsRepository
        .createQueryBuilder('s')
        .where('(s.name ILIKE :like OR s.name_ar ILIKE :like)', { like });

    const total = await base().getCount();
    const rows = await this.safeGetMany((useSimilarity) => {
      const qb = base()
        .skip((page - 1) * limit)
        .take(limit);
      return useSimilarity
        ? qb.orderBy('similarity(s.name, :q)', 'DESC').setParameter('q', q)
        : qb.orderBy('s.name', 'ASC');
    });

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
