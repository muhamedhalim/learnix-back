import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { UserApprovedEvent, UserRejectedEvent } from '../activity-logs/events/audit.events';
import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { ProductFinancialMetricsService } from '../common/metrics';
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
import { ReviewsService } from '../reviews/reviews.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { usableSubjectWhere } from '../subjects/subject-visibility.util';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  AssignSubjectsDto,
  PublicTeacherResponseDto,
  PromoteTeacherDto,
  RejectTeacherDto,
  TeacherFilterDto,
  UpdateTeacherProfileDto,
  toPublicTeacherResponse,
} from './dto';
import {
  CertificateEntry,
  EducationEntry,
  TeacherProfile,
} from './entities/teacher-profile.entity';

/**
 * Response type for teacher profile with user info and subjects
 */
export interface TeacherProfileWithDetails {
  id: string;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    profile_picture_url: string | null;
    status: UserStatus;
    rejection_reason: string | null;
    created_at: Date;
  };
  qualifications: string;
  years_of_experience: number;
  bio: string | null;
  bio_ar: string | null;
  professional_title: string | null;
  professional_title_ar: string | null;
  specializations: string[];
  languages: string[];
  skills: string[];
  education: EducationEntry[];
  certificates: CertificateEntry[];
  /**
   * Mean approved review rating, 2 dp. **`null` means "not yet rated"** — the
   * legacy `teacher_profiles.rating` column reported `0` for every teacher on
   * the platform because nothing maintained it (DEF-007).
   */
  rating: number | null;
  /** Approved reviews backing `rating`. */
  total_ratings: number;
  subjects: Subject[];
  created_at: Date;
  updated_at: Date;
}

/** Batch rating lookup keyed on `users.id`. @see ReviewsService.getTeacherRatingsBatch */
type TeacherRatingMap = Map<string, { average: number; count: number }>;

/**
 * `sortBy=rating` ordering key: the live average of approved reviews.
 *
 * Unrated teachers sort as 0 so they land at the bottom of a descending list
 * rather than being dropped by a NULL comparison — the response still reports
 * their rating as `null`, which is the distinction the UI renders.
 */
const TEACHER_RATING_SORT_SQL = `COALESCE((
  SELECT AVG(tr.rating)
    FROM teacher_reviews tr
   WHERE tr.teacher_id = teacher.user_id AND tr.status = 'approved'
), 0)`;

/**
 * Sanitized, public-facing teacher projection.
 *
 * Excludes all PII (email, phone, parent_phone, account status, rejection
 * reason). Used by the unauthenticated teacher directory / shop endpoints.
 */
/**
 * Summary stats for a teacher
 */
export interface TeacherStats {
  /** Non-deleted lessons owned by the teacher, in any publishing state. */
  lessonsCount: number;
  /** Unique students who have ever settled an order with this teacher. */
  studentsCount: number;
  /**
   * Teacher entitlement in **minor units**, net of refund reversals — the same
   * definition `ProductFinancialMetricsService` uses everywhere else. Previously
   * summed `teacher_earning_minor` over `status = 'paid'` alone, which counted
   * refunded sales at full value and dropped partially-refunded ones entirely.
   */
  totalEarnings: number;
  /** Currency of `totalEarnings`. */
  currency: string;
  /** Mean approved review rating, 2 dp. `null` when the teacher has no reviews. */
  averageRating: number | null;
  /** Approved reviews backing `averageRating`. */
  reviewCount: number;
}

/** T038 (W1-C6 d): anonymous, viewer-independent public catalog reads. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

@Injectable()
export class TeachersService {
  private readonly logger = new Logger(TeachersService.name);

  constructor(
    @InjectRepository(TeacherProfile)
    private readonly teacherProfilesRepository: Repository<TeacherProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly dataSource: DataSource,
    private readonly applicationCache: ApplicationCacheService,
    private readonly media: MediaService,
    private readonly activityLogs: ActivityLogsService,
    private readonly reviewsService: ReviewsService,
    private readonly productFinancialMetrics: ProductFinancialMetricsService,
  ) {}

  /**
   * Invalidate the cached admin dashboard so counters reflect role/status
   * changes immediately (the analytics service caches it for 5 minutes).
   */
  private async invalidateAdminDashboard(): Promise<void> {
    await this.applicationCache.invalidate([
      'admin_dashboard',
      'teacher_dashboard',
      'teacher_report',
    ]);
  }

  /**
   * Get a teacher's own profile by user ID
   * Used by teachers to view their profile
   */
  public async findTeacherProfile(userId: string): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody('Teacher profile not found', 'الملف الشخصي للمعلم غير موجود'),
      );
    }

    return await this.mapToProfileWithDetails(profile);
  }

  /**
   * Update teacher's own profile
   * Teachers can update their qualifications, bio, experience, and phone
   */
  public async updateProfile(
    userId: string,
    dto: UpdateTeacherProfileDto,
  ): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody('Teacher profile not found', 'الملف الشخصي للمعلم غير موجود'),
      );
    }

    // Update profile fields
    if (dto.qualifications !== undefined) {
      profile.qualifications = dto.qualifications;
    }
    if (dto.years_of_experience !== undefined) {
      profile.years_of_experience = dto.years_of_experience;
    }
    if (dto.bio !== undefined) {
      profile.bio = dto.bio;
    }
    if (dto.bio_ar !== undefined) {
      profile.bio_ar = dto.bio_ar;
    }
    if (dto.professional_title !== undefined) {
      profile.professional_title = dto.professional_title;
    }
    if (dto.professional_title_ar !== undefined) {
      profile.professional_title_ar = dto.professional_title_ar;
    }
    if (dto.specializations !== undefined) {
      profile.specializations = dto.specializations;
    }
    if (dto.languages !== undefined) {
      profile.languages = dto.languages;
    }
    if (dto.skills !== undefined) {
      profile.skills = dto.skills;
    }
    if (dto.education !== undefined) {
      profile.education = dto.education;
    }
    if (dto.certificates !== undefined) {
      profile.certificates = dto.certificates;
    }

    // Update phone on user entity
    if (dto.phone !== undefined) {
      profile.user.phone = dto.phone;
      await this.usersRepository.save(profile.user);
    }

    const savedProfile = await this.teacherProfilesRepository.save(profile);

    // Reload with relations
    const updatedProfile = await this.teacherProfilesRepository.findOne({
      where: { id: savedProfile.id },
      relations: ['user', 'subjects'],
    });

    if (!updatedProfile) {
      throw new NotFoundException(
        biBody(
          `Failed to reload teacher profile ${savedProfile.id}`,
          `فشل في إعادة تحميل الملف الشخصي للمعلم ${savedProfile.id}`,
        ),
      );
    }

    return await this.mapToProfileWithDetails(updatedProfile);
  }

  /**
   * Find all teachers with filtering, sorting, and pagination
   * Used by public endpoints and admin
   */
  public async findAllTeachers(
    filter: TeacherFilterDto,
  ): Promise<PaginatedResponse<TeacherProfileWithDetails>> {
    const {
      search,
      status,
      subjectId,
      sortBy = 'created_at',
      order = 'desc',
      page = 1,
      limit = 20,
    } = filter;

    // Filters, count and ordering run over profiles joined only to their user (one-to-one): the many-to-many
    // `subjects` join would multiply rows, and is hydrated for the page's ids afterwards.
    const queryBuilder = this.teacherProfilesRepository
      .createQueryBuilder('teacher')
      .leftJoin('teacher.user', 'user')
      .where('teacher.deleted_at IS NULL')
      .andWhere('user.deleted_at IS NULL');

    // Filter by user status
    if (status !== undefined) {
      queryBuilder.andWhere('user.status = :status', { status });
    }

    // Search by name or email. `first_name`/`last_name` are only populated
    // for admin-created accounts — every self-registered teacher (the normal
    // /auth/register path) only ever has `user.name` set, so a search on
    // first/last name alone silently excludes every pending self-registered
    // teacher even though the row exists and is visible in the unfiltered
    // list. Matching on `name` too keeps that path searchable.
    if (search !== undefined && search !== '') {
      queryBuilder.andWhere(
        `(user.first_name ILIKE :search
          OR user.last_name ILIKE :search
          OR user.name ILIKE :search
          OR user.email ILIKE :search
          OR user.username ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    // Filter by subject
    if (subjectId !== undefined && subjectId !== '') {
      queryBuilder.andWhere(
        'EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.teacher_profile_id = teacher.id AND ts.subject_id = :subjectId)',
        { subjectId },
      );
    }

    // Sorting
    const sortColumn =
      sortBy === 'name'
        ? 'user.first_name'
        : sortBy === 'rating'
          ? // Sorts on the live review average, not the dead denormalised
            // column — which ordered every teacher identically at 0.
            TEACHER_RATING_SORT_SQL
          : 'teacher.created_at';
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';

    // Get total count
    const total = await queryBuilder.getCount();

    // Page of ids ordered by an aliased sort expression (a raw expression cannot be an `orderBy` key next to
    // `skip/take`), then hydrate that page's relations and restore the id order.
    const pageIds = (
      await queryBuilder
        .clone()
        .select('teacher.id', 'id')
        .addSelect(sortColumn, 'sort_value')
        .orderBy('sort_value', sortOrder)
        .addOrderBy('teacher.id', sortOrder)
        .offset((page - 1) * limit)
        .limit(limit)
        .getRawMany<{ id: string }>()
    ).map((row) => row.id);
    const teachers = await this.hydrateTeachersInOrder(pageIds, () =>
      this.teacherProfilesRepository
        .createQueryBuilder('teacher')
        .leftJoinAndSelect('teacher.user', 'user')
        .leftJoinAndSelect('teacher.subjects', 'subjects'),
    );

    // Calculate pagination meta
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      data: await this.mapAllWithRatings(teachers, (t, ratings) =>
        this.mapToProfileWithDetails(t, ratings),
      ),
      meta,
    };
  }

  /**
   * Find pending teachers (for admin approval)
   */
  public async findPendingTeachers(
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<TeacherProfileWithDetails>> {
    return await this.findAllTeachers({
      status: UserStatus.PENDING,
      page,
      limit,
    });
  }

  /**
   * Find approved teachers (public listing)
   */
  public async findApprovedTeachers(
    filter: Omit<TeacherFilterDto, 'status'>,
  ): Promise<PaginatedResponse<TeacherProfileWithDetails>> {
    return await this.findAllTeachers({
      ...filter,
      status: UserStatus.APPROVED,
    });
  }

  /**
   * Public, unauthenticated directory listing of approved teachers.
   * Returns a sanitized projection with no email/phone/parent_phone/status.
   * Cached (T038, W1-C6 d): backs `GET teachers`, `GET teachers/by-subject/:subjectId`
   * and (via `SubjectsService.findTeachersBySubject`) `GET subjects/:id/teachers`.
   */
  public async findApprovedTeachersPublic(
    filter: Omit<TeacherFilterDto, 'status'>,
  ): Promise<PaginatedResponse<PublicTeacherResponseDto>> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'teachers.list',
        scope: 'public',
        parts: [
          (filter.search ?? '').trim().toLowerCase(),
          filter.subjectId ?? null,
          filter.sortBy ?? 'created_at',
          filter.order ?? 'desc',
          filter.page ?? 1,
          filter.limit ?? 20,
        ],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computeApprovedTeachersPublic(filter),
    );
  }

  private async computeApprovedTeachersPublic(
    filter: Omit<TeacherFilterDto, 'status'>,
  ): Promise<PaginatedResponse<PublicTeacherResponseDto>> {
    const {
      search,
      subjectId,
      sortBy = 'created_at',
      order = 'desc',
      page = 1,
      limit = 20,
    } = filter;

    const query = this.publicTeacherFilterQuery();
    if (search !== undefined && search !== '') {
      query.andWhere(
        '(user.name ILIKE :search OR user.first_name ILIKE :search OR user.last_name ILIKE :search)',
        { search: `%${search}%` },
      );
    }
    if (subjectId !== undefined && subjectId !== '') {
      query.andWhere(
        'EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.teacher_profile_id = teacher.id AND ts.subject_id = :subjectId)',
        { subjectId },
      );
    }

    const sortColumn =
      sortBy === 'name'
        ? 'user.name'
        : sortBy === 'rating'
          ? // Sorts on the live review average, not the dead denormalised
            // column — which ordered every teacher identically at 0.
            TEACHER_RATING_SORT_SQL
          : 'teacher.created_at';
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';

    const total = await query.getCount();
    const pageIds = (
      await query
        .clone()
        .select('teacher.id', 'id')
        .addSelect(sortColumn, 'sort_value')
        .orderBy('sort_value', sortOrder)
        .addOrderBy('teacher.id', sortOrder)
        .offset((page - 1) * limit)
        .limit(limit)
        .getRawMany<{ id: string }>()
    ).map((row) => row.id);
    // Hydrate through the same public projection (private user columns are never selected).
    const profiles = await this.hydrateTeachersInOrder(pageIds, () => this.publicTeacherQuery());
    const totalPages = Math.ceil(total / limit);

    return {
      data: await this.mapAllWithRatings(profiles, (profile, ratings) =>
        this.mapToPublicProfile(profile, ratings),
      ),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Public, unauthenticated single-teacher lookup.
   * Only returns APPROVED teachers, and only the sanitized projection.
   * Cached (T038, W1-C6 d): a 404 is thrown inside the compute callback, so
   * `getOrCompute` never stores a "not found" result.
   */
  public async findApprovedTeacherByIdPublic(id: string): Promise<PublicTeacherResponseDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'teachers.detail',
        scope: 'public',
        parts: [id],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computeApprovedTeacherByIdPublic(id),
    );
  }

  private async computeApprovedTeacherByIdPublic(id: string): Promise<PublicTeacherResponseDto> {
    const profile = await this.publicTeacherQuery().andWhere('teacher.id = :id', { id }).getOne();

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${id} not found`, `المعلم بالمعرّف ${id} غير موجود`),
      );
    }

    return await this.mapToPublicProfile(profile);
  }

  /** The public visibility filter alone (approved, not deleted), with no select list and no to-many join. */
  private publicTeacherFilterQuery(): SelectQueryBuilder<TeacherProfile> {
    return this.teacherProfilesRepository
      .createQueryBuilder('teacher')
      .leftJoin('teacher.user', 'user')
      .where('teacher.deleted_at IS NULL')
      .andWhere('user.deleted_at IS NULL')
      .andWhere('user.status = :publicStatus', { publicStatus: UserStatus.APPROVED });
  }

  /** Loads the profiles of one page of ids with `build()`'s projection and returns them in the ids' order. */
  private async hydrateTeachersInOrder(
    pageIds: string[],
    build: () => SelectQueryBuilder<TeacherProfile>,
  ): Promise<TeacherProfile[]> {
    if (pageIds.length === 0) return [];
    const rows = await build().andWhere('teacher.id = ANY(:pageIds)', { pageIds }).getMany();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return pageIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  /** Query boundary for public teacher data: private User columns are never selected. */
  private publicTeacherQuery(): SelectQueryBuilder<TeacherProfile> {
    return this.teacherProfilesRepository
      .createQueryBuilder('teacher')
      .leftJoin('teacher.user', 'user')
      .leftJoin('teacher.subjects', 'subjects')
      .select([
        'teacher.id',
        // Needed to look up the teacher's reviews, which key on users.id.
        // Not a PII widening — the same id is already exposed as `user.id`.
        'teacher.user_id',
        'teacher.qualifications',
        'teacher.years_of_experience',
        'teacher.bio',
        'teacher.bio_ar',
        'teacher.professional_title',
        'teacher.professional_title_ar',
        'teacher.specializations',
        'teacher.languages',
        'teacher.skills',
        'teacher.education',
        'teacher.certificates',
        'teacher.rating',
        'teacher.total_ratings',
        'teacher.created_at',
        'user.id',
        'user.name',
        'user.profile_picture_url',
        'subjects.id',
        'subjects.name',
      ])
      .where('teacher.deleted_at IS NULL')
      .andWhere('user.deleted_at IS NULL')
      .andWhere('user.status = :publicStatus', { publicStatus: UserStatus.APPROVED });
  }

  /**
   * Get a single teacher by profile ID
   * Used by admin to view any teacher's details
   */
  public async findTeacherById(id: string): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${id} not found`, `المعلم بالمعرّف ${id} غير موجود`),
      );
    }

    return await this.mapToProfileWithDetails(profile);
  }

  /**
   * Approve a pending teacher
   * Sets user status to APPROVED
   * @param profileId - Teacher profile ID (numeric)
   * @param notes - Optional approval notes (will be stored in audit_logs table)
   */
  public async approveTeacher(
    profileId: string,
    notes?: string,
    actorId?: string,
    ipAddress?: string,
  ): Promise<TeacherProfileWithDetails> {
    // A plain findOne()-then-save() has a check-then-act race: two concurrent
    // approve/reject calls (a double-click, or two admins) can both read the
    // row while status is still PENDING, both pass the conflict check below,
    // and both write — the last save() wins silently with no error to either
    // caller. Locking the user row for the lifetime of the transaction closes
    // that window: the second transaction blocks until the first commits,
    // then re-reads the now-APPROVED/REJECTED row and hits the conflict check
    // for real, mirroring the pattern AuthService.rotateRefreshSession uses.
    const profile = await this.dataSource.transaction(async (manager) => {
      const teacherProfile = await manager.findOne(TeacherProfile, {
        where: { id: profileId },
        relations: ['subjects'],
      });

      if (!teacherProfile) {
        throw new NotFoundException(
          biBody(
            `Teacher with ID ${profileId} not found`,
            `المعلم بالمعرّف ${profileId} غير موجود`,
          ),
        );
      }

      const user = await manager.findOne(User, {
        where: { id: teacherProfile.user_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        throw new NotFoundException(
          biBody(
            `Teacher with ID ${profileId} not found`,
            `المعلم بالمعرّف ${profileId} غير موجود`,
          ),
        );
      }

      if (user.status === UserStatus.APPROVED) {
        throw new ConflictException(biBody('Teacher is already approved', 'المعلم معتمد بالفعل'));
      }

      user.status = UserStatus.APPROVED;
      user.rejection_reason = null;
      await manager.save(User, user);

      teacherProfile.user = user;
      return teacherProfile;
    });

    // Approval is a reviewable administrative decision, so it is recorded in
    // `audit_logs` alongside every other admin action. The actor is optional
    // only for internal callers that have no request context; admin routes
    // always supply it.
    if (actorId) {
      await this.activityLogs.recordAuditEvent(
        new UserApprovedEvent(
          actorId,
          profile.user.id,
          {
            userName: profile.user.name,
            userEmail: profile.user.email,
            userRole: 'teacher',
            ...(notes?.trim() ? { notes: notes.trim() } : {}),
          },
          ipAddress,
        ),
      );
    }

    // TODO: Send notification to teacher about approval

    await this.invalidateAdminDashboard();

    return await this.mapToProfileWithDetails(profile);
  }

  /**
   * Reject a pending teacher
   * Sets user status to REJECTED with reason
   */
  public async rejectTeacher(
    profileId: string,
    dto: RejectTeacherDto,
    actorId?: string,
    ipAddress?: string,
  ): Promise<TeacherProfileWithDetails> {
    // Same TOCTOU concern as approveTeacher — lock the user row for the
    // transaction so a concurrent approve/reject on the same profile can't
    // both win silently.
    const profile = await this.dataSource.transaction(async (manager) => {
      const teacherProfile = await manager.findOne(TeacherProfile, {
        where: { id: profileId },
        relations: ['subjects'],
      });

      if (!teacherProfile) {
        throw new NotFoundException(
          biBody(
            `Teacher with ID ${profileId} not found`,
            `المعلم بالمعرّف ${profileId} غير موجود`,
          ),
        );
      }

      const user = await manager.findOne(User, {
        where: { id: teacherProfile.user_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        throw new NotFoundException(
          biBody(
            `Teacher with ID ${profileId} not found`,
            `المعلم بالمعرّف ${profileId} غير موجود`,
          ),
        );
      }

      if (user.status === UserStatus.REJECTED) {
        throw new ConflictException(biBody('Teacher is already rejected', 'المعلم مرفوض بالفعل'));
      }

      user.status = UserStatus.REJECTED;
      user.rejection_reason = dto.reason;
      await manager.save(User, user);

      teacherProfile.user = user;
      return teacherProfile;
    });

    if (actorId) {
      await this.activityLogs.recordAuditEvent(
        new UserRejectedEvent(
          actorId,
          profile.user.id,
          {
            userName: profile.user.name,
            userEmail: profile.user.email,
            userRole: 'teacher',
            reason: dto.reason,
          },
          ipAddress,
        ),
      );
    }

    // TODO: Send notification to teacher about rejection

    await this.invalidateAdminDashboard();

    return await this.mapToProfileWithDetails(profile);
  }

  /**
   * Assign subjects to a teacher
   * Replaces all existing subject assignments
   */
  public async assignSubjects(
    profileId: string,
    dto: AssignSubjectsDto,
  ): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${profileId} not found`, `المعلم بالمعرّف ${profileId} غير موجود`),
      );
    }

    // Validate the subject IDs exist and are usable by the teacher being
    // assigned to. This is an admin-driven action, so the relevant owner is the
    // target profile's user — not the acting admin: an admin may assign the
    // approved catalogue, plus that teacher's own pending submissions.
    const subjects = await this.subjectsRepository.findBy(
      usableSubjectWhere(profile.user_id).map((clause) => ({
        ...clause,
        id: In(dto.subjectIds),
      })),
    );

    if (subjects.length !== dto.subjectIds.length) {
      const foundIds = new Set(subjects.map((s) => s.id));
      const missingIds = dto.subjectIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        biBody(
          `Subjects not found: ${missingIds.join(', ')}`,
          `المواد التالية غير موجودة: ${missingIds.join(', ')}`,
        ),
      );
    }

    // Replace subjects
    profile.subjects = subjects;
    await this.teacherProfilesRepository.save(profile);

    // Reload with all relations
    const updatedProfile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['user', 'subjects'],
    });

    if (!updatedProfile) {
      throw new NotFoundException(
        biBody(
          `Failed to reload teacher profile ${profileId}`,
          `فشل في إعادة تحميل الملف الشخصي للمعلم ${profileId}`,
        ),
      );
    }

    return await this.mapToProfileWithDetails(updatedProfile);
  }

  /**
   * Get teacher statistics
   * Returns lesson count, student count, total earnings, etc.
   */
  public async getTeacherStats(profileId: string): Promise<TeacherStats> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${profileId} not found`, `المعلم بالمعرّف ${profileId} غير موجود`),
      );
    }

    // Content and commerce rows key on `users.id`, not on the profile id.
    const userId = profile.user_id;

    const [lessonRows, financial, studentsCount, rating] = await Promise.all([
      this.dataSource.query<Array<{ lessons_count: string }>>(
        `SELECT COUNT(*)::text AS lessons_count
           FROM lessons
          WHERE teacher_id = $1 AND deleted_at IS NULL`,
        [userId],
      ),
      // Delegated so earnings here mean exactly what they mean in every other
      // financial surface — settled orders, net of proportional refund
      // reversal — instead of this method's former private formula.
      this.productFinancialMetrics.getTeacherFinancialMetrics(userId),
      this.productFinancialMetrics.getTeacherUniqueStudentCount(userId),
      this.reviewsService.getTeacherAggregates(userId),
    ]);

    return {
      lessonsCount: Number(lessonRows[0]?.lessons_count ?? 0),
      studentsCount,
      /** Minor units (piastres), consistent with every other financial figure. */
      totalEarnings: financial.primary.teacher_earnings_minor,
      currency: financial.primary.currency,
      averageRating: rating.total_reviews === 0 ? null : rating.average_rating,
      reviewCount: rating.total_reviews,
    };
  }

  /**
   * Create a teacher profile for a user
   * Called during teacher registration
   */
  public async createTeacherProfile(
    userId: string,
    qualifications: string,
    yearsOfExperience: number,
    bio?: string,
  ): Promise<TeacherProfile> {
    // Check if user exists and has teacher role
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    if (user.role !== UserRole.TEACHER) {
      throw new BadRequestException(
        biBody('User must have TEACHER role', 'يجب أن يكون المستخدم بدور معلم'),
      );
    }

    // Check if profile already exists
    const existingProfile = await this.teacherProfilesRepository.findOne({
      where: { user_id: userId },
    });

    if (existingProfile) {
      throw new ConflictException(
        biBody(
          'Teacher profile already exists for this user',
          'يوجد بالفعل ملف شخصي كمعلم لهذا المستخدم',
        ),
      );
    }

    // Create profile
    const profile = this.teacherProfilesRepository.create({
      user_id: userId,
      qualifications,
      years_of_experience: yearsOfExperience,
      bio: bio ?? null,
      rating: 0,
      total_ratings: 0,
    });

    return await this.teacherProfilesRepository.save(profile);
  }

  /**
   * Promote an existing STUDENT account into a TEACHER.
   *
   * Atomic (single transaction): flips the role to TEACHER, marks the account
   * APPROVED so it can log in immediately, soft-removes the student profile so
   * the user leaves the students list, and creates (or restores) the teacher
   * profile so the user appears in the teachers list.
   */
  public async promoteStudentToTeacher(
    userId: string,
    dto: PromoteTeacherDto,
  ): Promise<TeacherProfileWithDetails> {
    const profileId = await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const studentRepo = manager.getRepository(StudentProfile);
      const teacherRepo = manager.getRepository(TeacherProfile);

      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException(
          biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
        );
      }
      if (user.role === UserRole.TEACHER) {
        throw new ConflictException(biBody('User is already a teacher', 'المستخدم معلم بالفعل'));
      }
      if (user.role !== UserRole.STUDENT) {
        throw new BadRequestException(
          biBody(
            'Only student accounts can be promoted to teacher',
            'يمكن ترقية حسابات الطلاب فقط إلى معلم',
          ),
        );
      }

      // 1) Role + status so the user can log in and route as a teacher.
      user.role = UserRole.TEACHER;
      user.status = UserStatus.APPROVED;
      user.rejection_reason = null;
      await userRepo.save(user);

      // 2) Remove the student profile (soft delete) → leaves the students list.
      const studentProfile = await studentRepo.findOne({
        where: { user_id: userId },
      });
      if (studentProfile) {
        await studentRepo.softRemove(studentProfile);
      }

      // 3) Create (or restore) the teacher profile → enters the teachers list.
      const existing = await teacherRepo.findOne({
        where: { user_id: userId },
        withDeleted: true,
      });

      let profile: TeacherProfile;
      if (existing) {
        existing.deleted_at = null;
        existing.qualifications = dto.qualifications ?? existing.qualifications ?? 'Pending review';
        existing.years_of_experience = dto.years_of_experience ?? existing.years_of_experience ?? 0;
        existing.bio = dto.bio ?? existing.bio ?? null;
        profile = await teacherRepo.save(existing);
      } else {
        profile = await teacherRepo.save(
          teacherRepo.create({
            user_id: userId,
            qualifications: dto.qualifications ?? 'Pending review',
            years_of_experience: dto.years_of_experience ?? 0,
            bio: dto.bio ?? null,
            rating: 0,
            total_ratings: 0,
          }),
        );
      }

      return profile.id;
    });

    this.logger.log(`User ${userId} promoted to TEACHER (profile ${profileId})`);

    await this.invalidateAdminDashboard();

    return this.findTeacherById(profileId);
  }

  /*
   * `updateTeacherRating` used to live here: it incrementally folded a new
   * rating into `teacher_profiles.rating`/`total_ratings`. Nothing ever called
   * it — `ReviewsService` writes `teacher_reviews` and never touched the
   * profile — so those columns stayed at 0 for every teacher while being
   * published as "rating" (DEF-007). Ratings are now derived from approved
   * reviews on read via `ReviewsService.getTeacherRatingsBatch`, so there is no
   * counter to keep in sync and no way for the two to drift apart.
   */

  /**
   * Helper method to map TeacherProfile entity to response type
   */
  /**
   * Map a teacher profile to the sanitized, PII-free public projection.
   * Never include email/phone/parent_phone/status here.
   */
  private async mapToPublicProfile(
    profile: TeacherProfile,
    preloaded?: TeacherRatingMap,
  ): Promise<PublicTeacherResponseDto> {
    const rating = await this.resolveRating(profile, preloaded);
    return toPublicTeacherResponse(
      profile,
      (value) => this.media.resolveThumbnailUrl(value),
      rating,
    );
  }

  /**
   * The teacher's live rating from approved reviews.
   *
   * `teacher_profiles.rating` / `.total_ratings` are legacy columns that no code
   * path ever wrote (`updateTeacherRating` had no caller), so every teacher on
   * the platform was published with a hard `0` rating — including on the
   * unauthenticated directory and its `sortBy=rating` ordering (DEF-007).
   * `ReviewsService` owns the definition; this only chooses between the batch
   * map a list already loaded and a single lookup for detail responses.
   */
  private async resolveRating(
    profile: TeacherProfile,
    preloaded?: TeacherRatingMap,
  ): Promise<{ average: number | null; count: number }> {
    const found = preloaded
      ? preloaded.get(profile.user_id)
      : (await this.reviewsService.getTeacherRatingsBatch([profile.user_id])).get(profile.user_id);
    // Absent from the map means no approved reviews: "not rated", not 0 stars.
    return { average: found?.average ?? null, count: found?.count ?? 0 };
  }

  /**
   * Map a page of profiles with their ratings loaded in a single query, so a
   * paginated list never issues one rating lookup per row.
   */
  private async mapAllWithRatings<T>(
    profiles: readonly TeacherProfile[],
    map: (profile: TeacherProfile, ratings: TeacherRatingMap) => Promise<T>,
  ): Promise<T[]> {
    const ratings = await this.reviewsService.getTeacherRatingsBatch(
      profiles.map((profile) => profile.user_id),
    );
    return await Promise.all(profiles.map((profile) => map(profile, ratings)));
  }

  private async mapToProfileWithDetails(
    profile: TeacherProfile,
    preloaded?: TeacherRatingMap,
  ): Promise<TeacherProfileWithDetails> {
    const rating = await this.resolveRating(profile, preloaded);
    return {
      id: profile.id,
      user: {
        id: profile.user.id,
        name: profile.user.name,
        email: profile.user.email,
        phone: profile.user.phone,
        profile_picture_url: this.media.resolveThumbnailUrl(profile.user.profile_picture_url),
        status: profile.user.status,
        rejection_reason: profile.user.rejection_reason,
        created_at: profile.user.created_at,
      },
      qualifications: profile.qualifications,
      years_of_experience: profile.years_of_experience,
      bio: profile.bio,
      bio_ar: profile.bio_ar,
      professional_title: profile.professional_title,
      professional_title_ar: profile.professional_title_ar,
      specializations: profile.specializations,
      languages: profile.languages,
      skills: profile.skills,
      education: profile.education,
      certificates: profile.certificates,
      rating: rating.average,
      total_ratings: rating.count,
      subjects: profile.subjects,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }
}
