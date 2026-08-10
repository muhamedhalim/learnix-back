import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { LearningMetricsService } from '../common/metrics';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardiansService } from '../guardians/guardians.service';
import { biBody } from '../i18n/error-translator.util';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  RejectStudentDto,
  StudentFilterDto,
  UpdateStudentNotificationSettingsDto,
  UpdateStudentProfileDto,
} from './dto';
import { StudentProfile } from './entities/student-profile.entity';

/**
 * Response type for student profile with user info
 */
export interface StudentProfileWithDetails {
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
  country: string | null;
  governorate: string | null;
  school: string | null;
  is_public_profile: boolean;
  notification_settings: Record<string, boolean>;
  /** Primary guardian's phone (E.164), or null if none is linked yet (legacy data). */
  guardian_phone: string | null;
  created_at: Date;
  updated_at: Date;
  purchasedLessons?: Array<{
    lessonId: string;
    /** Null when the purchased lesson was soft-deleted after purchase. */
    title: string | null;
    attended: boolean;
    purchasedAt: Date;
    expiresAt: Date;
    pricePaid: number;
    isExpired: boolean;
  }>;
  exams?: Array<{
    examId: string;
    /** Null when the historical exam was soft-deleted. */
    title: string | null;
    score: number | null;
    totalMarks: number | null;
    status: string;
    submittedAt: Date | null;
  }>;
}

/**
 * Sanitized, public-facing student projection.
 *
 * Intentionally excludes all PII (email, phone, parent_phone, account status,
 * rejection reason). Used by the unauthenticated public directory endpoints so
 * approved students can be surfaced without leaking contact details.
 */
export interface PublicStudentProfile {
  id: string;
  user: {
    id: string;
    name: string;
    profile_picture_url: string | null;
  };
  country: string | null;
  governorate: string | null;
  school: string | null;
  created_at: Date;
}

/**
 * Summary stats for a student, as returned by `GET /admin/students/:id/stats`
 * and `GET /student/profile/stats`.
 *
 * Every field is a real query against the canonical tables (DEF-007); the
 * previous implementation returned four hardcoded zeros.
 */
export interface StudentStats {
  /** Distinct lessons marked completed in `lesson_progress`. */
  lessonsCompleted: number;
  /**
   * Distinct lessons the student holds non-revoked access to — direct lesson
   * purchases *and* lessons inside purchased courses, since both write a
   * `lesson_purchases` row. Access revoked by a full refund is excluded.
   */
  lessonsPurchased: number;
  /** Distinct courses the student holds non-revoked access to. */
  coursesPurchased: number;
  /** Exam attempts in the terminal `graded` state. */
  examsCompleted: number;
  /**
   * Mean percentage score across graded attempts (`score_total / max_score`),
   * 2 dp. **`null` means "has never completed a graded exam"** — reporting `0`
   * there would misread as a failing student.
   */
  averageScore: number | null;
}

@Injectable()
export class StudentsService {
  private readonly logger = new Logger(StudentsService.name);

  constructor(
    @InjectRepository(StudentProfile)
    private readonly studentProfilesRepository: Repository<StudentProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchasesRepository: Repository<LessonPurchase>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptsRepository: Repository<ExamAttempt>,
    private readonly applicationCache: ApplicationCacheService,
    private readonly guardiansService: GuardiansService,
    private readonly learningMetrics: LearningMetricsService,
  ) {}

  /**
   * Get a student's own profile by user ID with aggregated data
   * Used by students to view their profile
   * Includes purchased lessons and exam attempts with caching (5-min TTL)
   */
  public async findStudentProfile(userId: string): Promise<StudentProfileWithDetails> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'student_profile',
        endpoint: 'students.profile',
        scope: `owner:${userId}`,
        parts: [userId],
        ttlMs: 60_000,
      },
      async () => {

    // Fetch basic profile
    const profile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody('Student profile not found', 'الملف الشخصي للطالب غير موجود'),
      );
    }

    // Fetch purchased lessons with lesson details
    const lessonPurchases = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .leftJoinAndSelect('lp.lesson', 'lesson')
      .where('lp.student_id = :userId', { userId })
      .orderBy('lp.created_at', 'DESC')
      .getMany();

    // Fetch exam attempts with exam details
    const examAttempts = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .leftJoinAndSelect('ea.exam', 'exam')
      .where('ea.student_id = :userId', { userId })
      .orderBy('ea.created_at', 'DESC')
      .getMany();

    // Map to response format
    const now = new Date();
    const purchasedLessons = lessonPurchases.map((lp) => ({
      lessonId: lp.lesson_id,
      // TypeORM excludes soft-deleted related records from relation loading.
      // Keep the historical purchase readable when its lesson no longer exists.
      title: lp.lesson?.title ?? null,
      attended: Boolean(lp.access_granted_at),
      purchasedAt: lp.created_at,
      expiresAt: lp.access_expires_at,
      pricePaid: lp.price_paid,
      isExpired: lp.access_expires_at < now,
    }));

    const exams = examAttempts.map((ea) => ({
      examId: ea.exam_id,
      // Exam attempts remain useful in a student's history after an exam has
      // been soft-deleted, so the response deliberately exposes null metadata.
      title: ea.exam?.title ?? null,
      score: ea.score_total,
      totalMarks: ea.exam?.total_marks ?? null,
      status: ea.state,
      submittedAt: ea.submitted_at,
    }));

    // Build complete profile
    const profileWithDetails: StudentProfileWithDetails = {
      ...this.mapToProfileWithDetails(profile),
      purchasedLessons,
      exams,
    };

        return profileWithDetails;
      },
    );
  }

  /**
   * Update student's own profile
   * Students can update their profile preferences and optional demographics.
   */
  public async updateProfile(
    userId: string,
    dto: UpdateStudentProfileDto,
  ): Promise<StudentProfileWithDetails> {
    const profile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody('Student profile not found', 'الملف الشخصي للطالب غير موجود'),
      );
    }

    // Guardian phone numbers are no longer editable here — see
    // `PATCH /student/guardians/:guardianId/phone`, which refuses to rewrite a
    // verified number without a fresh OTP.
    if (dto.country !== undefined) {
      profile.country = dto.country;
    }
    if (dto.governorate !== undefined) {
      profile.governorate = dto.governorate;
    }
    if (dto.school !== undefined) {
      profile.school = dto.school;
    }
    if (dto.is_public_profile !== undefined) {
      profile.is_public_profile = dto.is_public_profile;
    }

    const savedProfile = await this.studentProfilesRepository.save(profile);

    // Reload with relations
    const updatedProfile = await this.studentProfilesRepository.findOne({
      where: { id: savedProfile.id },
      relations: ['user'],
    });

    if (!updatedProfile) {
      throw new NotFoundException(
        biBody('Failed to load updated profile', 'فشل في تحميل الملف الشخصي المحدث'),
      );
    }

    return this.mapToProfileWithDetails(updatedProfile);
  }

  /**
   * Update student's notification settings
   */
  public async updateNotificationSettings(
    userId: string,
    dto: UpdateStudentNotificationSettingsDto,
  ): Promise<StudentProfileWithDetails> {
    const profile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody('Student profile not found', 'الملف الشخصي للطالب غير موجود'),
      );
    }

    profile.notification_settings = dto.notification_settings;

    const savedProfile = await this.studentProfilesRepository.save(profile);

    // Reload with relations
    const updatedProfile = await this.studentProfilesRepository.findOne({
      where: { id: savedProfile.id },
      relations: ['user'],
    });

    if (!updatedProfile) {
      throw new NotFoundException(
        biBody('Failed to load updated profile', 'فشل في تحميل الملف الشخصي المحدث'),
      );
    }

    return this.mapToProfileWithDetails(updatedProfile);
  }

  /**
   * Find all students with filtering, sorting, and pagination
   * Used by admin endpoints
   */
  public async findAllStudents(
    filter: StudentFilterDto,
    options: { publicSearch?: boolean } = {},
  ): Promise<PaginatedResponse<StudentProfileWithDetails>> {
    const {
      search,
      status,
      sortBy = 'created_at',
      order = 'desc',
      page = 1,
      limit = 20,
    } = filter;

    const queryBuilder = this.studentProfilesRepository
      .createQueryBuilder('student')
      .leftJoinAndSelect('student.user', 'user')
      .where('student.deleted_at IS NULL')
      .andWhere('user.deleted_at IS NULL');

    // Filter by user status
    if (status !== undefined) {
      queryBuilder.andWhere('user.status = :status', { status });
    }

    // Search by name or email. The unauthenticated public directory must not
    // match on email: emails are never returned publicly, so matching on them
    // would let anyone confirm which student an email address belongs to.
    if (search !== undefined && search !== '') {
      queryBuilder.andWhere(
        options.publicSearch === true
          ? `(user.first_name ILIKE :search
          OR user.last_name ILIKE :search
          OR user.username ILIKE :search)`
          : `(user.first_name ILIKE :search
          OR user.last_name ILIKE :search
          OR user.email ILIKE :search
          OR user.username ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    // Sorting
    const sortColumn =
      sortBy === 'name'
        ? 'user.first_name'
        : 'student.created_at';
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    queryBuilder.orderBy(sortColumn, sortOrder).addOrderBy('student.id', sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const students = await queryBuilder.getMany();

    // One batched query for the whole page's primary guardian phones — never
    // N+1 per row. See GuardiansService.findPrimaryPhonesForStudents.
    const guardianPhonesByStudent = await this.guardiansService.findPrimaryPhonesForStudents(
      students.map((s) => s.user_id),
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
      data: students.map((s) =>
        this.mapToProfileWithDetails(s, guardianPhonesByStudent.get(s.user_id) ?? null),
      ),
      meta,
    };
  }

  /**
   * Find pending students (for admin approval)
   */
  public async findPendingStudents(
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<StudentProfileWithDetails>> {
    return await this.findAllStudents({
      status: UserStatus.PENDING,
      page,
      limit,
    });
  }

  /**
   * Find approved students (public listing) — full detail.
   * Internal/admin use only; callers must be authorized. Public controllers
   * must use {@link findApprovedStudentsPublic} to avoid exposing PII.
   */
  public async findApprovedStudents(
    filter: Omit<StudentFilterDto, 'status'>,
    options: { publicSearch?: boolean } = {},
  ): Promise<PaginatedResponse<StudentProfileWithDetails>> {
    return await this.findAllStudents(
      {
        ...filter,
        status: UserStatus.APPROVED,
      },
      options,
    );
  }

  /**
   * Public, unauthenticated directory listing of approved students.
   * Returns a sanitized projection with no email/phone/parent_phone/status.
   */
  public async findApprovedStudentsPublic(
    filter: Omit<StudentFilterDto, 'status'>,
  ): Promise<PaginatedResponse<PublicStudentProfile>> {
    const result = await this.findApprovedStudents(filter, { publicSearch: true });
    return {
      data: result.data.map((student) => ({
        id: student.id,
        user: {
          id: student.user.id,
          name: student.user.name,
          profile_picture_url: student.user.profile_picture_url,
        },
        country: student.country,
        governorate: student.governorate,
        school: student.school,
        created_at: student.created_at,
      })),
      meta: result.meta,
    };
  }

  /**
   * Public, unauthenticated single-student lookup.
   * Only returns APPROVED students, and only the sanitized projection.
   */
  public async findApprovedStudentByIdPublic(id: string): Promise<PublicStudentProfile> {
    const profile = await this.studentProfilesRepository.findOne({
      where: [
        { id, user: { status: UserStatus.APPROVED } },
        { user_id: id, user: { status: UserStatus.APPROVED } },
      ],
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Student with ID ${id} not found`, `الطالب بالمعرّف ${id} غير موجود`),
      );
    }

    return this.mapToPublicProfile(profile);
  }

  /**
   * Get a single student by profile ID
   * Used by admin to view any student's details
   */
  public async findStudentById(id: string): Promise<StudentProfileWithDetails> {
    const profile = await this.studentProfilesRepository.findOne({
      where: [{ id }, { user_id: id }],
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Student with ID ${id} not found`, `الطالب بالمعرّف ${id} غير موجود`),
      );
    }

    return this.mapToProfileWithDetails(profile);
  }

  /**
   * Approve a pending student
   * Sets user status to APPROVED
   * @param profileId - Student profile ID (numeric)
   * @param notes - Optional approval notes (stored for audit trail)
   */
  public async approveStudent(
    profileId: string,
    notes?: string,
  ): Promise<StudentProfileWithDetails> {
    const profile = await this.studentProfilesRepository.findOne({
      where: [{ id: profileId }, { user_id: profileId }],
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Student with ID ${profileId} not found`, `الطالب بالمعرّف ${profileId} غير موجود`),
      );
    }

    if (profile.user.status === UserStatus.APPROVED) {
      throw new ConflictException(biBody('Student is already approved', 'الطالب معتمد بالفعل'));
    }

    // Update user status
    profile.user.status = UserStatus.APPROVED;
    profile.user.rejection_reason = null;

    await this.usersRepository.save(profile.user);

    // TODO: Store approval notes in audit_logs table
    // TODO: Send notification to student/parent about approval
    if (notes !== undefined && notes !== '') {
      // For now, just log. Later: save to audit_logs table
      this.logger.log(`Student ${profileId} approved with notes: ${notes}`);
    }

    // Refresh the cached admin dashboard so counters reflect the new status.
    await this.applicationCache.invalidate(['admin_dashboard', 'student_profile']);

    return this.mapToProfileWithDetails(profile);
  }

  /**
   * Reject a pending student
   * Sets user status to REJECTED with reason
   */
  public async rejectStudent(
    profileId: string,
    dto: RejectStudentDto,
  ): Promise<StudentProfileWithDetails> {
    const profile = await this.studentProfilesRepository.findOne({
      where: [{ id: profileId }, { user_id: profileId }],
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Student with ID ${profileId} not found`, `الطالب بالمعرّف ${profileId} غير موجود`),
      );
    }

    if (profile.user.status === UserStatus.REJECTED) {
      throw new ConflictException(biBody('Student is already rejected', 'الطالب مرفوض بالفعل'));
    }

    // Update user status with rejection reason
    profile.user.status = UserStatus.REJECTED;
    profile.user.rejection_reason = dto.reason;

    await this.usersRepository.save(profile.user);

    // TODO: Send notification to student/parent about rejection
    // TODO: Log audit trail for rejection action

    // Refresh the cached admin dashboard so counters reflect the new status.
    await this.applicationCache.invalidate(['admin_dashboard', 'student_profile']);

    return this.mapToProfileWithDetails(profile);
  }

  /**
   * Get student statistics from the canonical learning tables.
   *
   * @param profileId accepts either a `student_profiles.id` or the underlying
   *   `users.id`, matching the existing lookup contract. Purchases, progress
   *   and attempts all key on the **user** id, so the profile is resolved first
   *   and `profile.user_id` is what the metrics layer is asked about — passing
   *   the profile id straight through would silently return zeros.
   */
  public async getStudentStats(profileId: string): Promise<StudentStats> {
    const profile = await this.studentProfilesRepository.findOne({
      where: [{ id: profileId }, { user_id: profileId }],
      select: { id: true, user_id: true },
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Student with ID ${profileId} not found`, `الطالب بالمعرّف ${profileId} غير موجود`),
      );
    }

    const metrics = await this.learningMetrics.getStudentLearningMetrics(profile.user_id);

    return {
      lessonsCompleted: metrics.lessons_completed,
      lessonsPurchased: metrics.lessons_purchased,
      coursesPurchased: metrics.courses_purchased,
      examsCompleted: metrics.exams_completed,
      averageScore: metrics.average_score_percent,
    };
  }

  /**
   * Create a student profile for a user
   * Called during student registration
   */
  public async createStudentProfile(userId: string): Promise<StudentProfile> {
    // Check if user exists and has student role
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    if (user.role !== UserRole.STUDENT) {
      throw new BadRequestException(
        biBody('User must have STUDENT role', 'يجب أن يكون المستخدم بدور طالب'),
      );
    }

    // Check if profile already exists
    const existingProfile = await this.studentProfilesRepository.findOne({
      where: { user_id: userId },
    });

    if (existingProfile) {
      throw new ConflictException(
        biBody(
          'Student profile already exists for this user',
          'يوجد بالفعل ملف شخصي كطالب لهذا المستخدم',
        ),
      );
    }

    // Create profile with default notification settings
    const profile = this.studentProfilesRepository.create({
      user_id: userId,
      notification_settings: {
        sms_enabled: true,
        email_enabled: true,
        lesson_reminders: true,
        exam_results: true,
        payment_notifications: true,
      },
    });

    return await this.studentProfilesRepository.save(profile);
  }

  /**
   * Helper method to map StudentProfile entity to response type
   */
  /**
   * Map a student profile to the sanitized, PII-free public projection.
   * Never include email/phone/parent_phone/status here — this feeds
   * unauthenticated endpoints.
   */
  private mapToPublicProfile(profile: StudentProfile): PublicStudentProfile {
    return {
      id: profile.id,
      user: {
        id: profile.user.id,
        name: profile.user.name,
        profile_picture_url: profile.user.profile_picture_url,
      },
      country: profile.country,
      governorate: profile.governorate,
      school: profile.school,
      created_at: profile.created_at,
    };
  }

  private mapToProfileWithDetails(
    profile: StudentProfile,
    guardianPhone: string | null = null,
  ): StudentProfileWithDetails {
    return {
      id: profile.id,
      user: {
        id: profile.user.id,
        name: profile.user.name,
        email: profile.user.email,
        phone: profile.user.phone,
        profile_picture_url: profile.user.profile_picture_url,
        status: profile.user.status,
        rejection_reason: profile.user.rejection_reason,
        created_at: profile.user.created_at,
      },
      country: profile.country,
      governorate: profile.governorate,
      school: profile.school,
      is_public_profile: profile.is_public_profile,
      notification_settings: profile.notification_settings,
      guardian_phone: guardianPhone,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }
}
