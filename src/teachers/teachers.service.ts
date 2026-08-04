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
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
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
import { CertificateEntry, EducationEntry, TeacherProfile } from './entities/teacher-profile.entity';

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
  rating: number;
  total_ratings: number;
  subjects: Subject[];
  created_at: Date;
  updated_at: Date;
}

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
  lessonsCount: number;
  studentsCount: number;
  totalEarnings: number;
  averageRating: number;
}

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
  ) {}

  /**
   * Invalidate the cached admin dashboard so counters reflect role/status
   * changes immediately (the analytics service caches it for 5 minutes).
   */
  private async invalidateAdminDashboard(): Promise<void> {
    await this.applicationCache.invalidate(['admin_dashboard', 'teacher_dashboard', 'teacher_report']);
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

    return this.mapToProfileWithDetails(profile);
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

    return this.mapToProfileWithDetails(updatedProfile);
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

    const queryBuilder = this.teacherProfilesRepository
      .createQueryBuilder('teacher')
      .leftJoinAndSelect('teacher.user', 'user')
      .leftJoinAndSelect('teacher.subjects', 'subjects')
      .where('teacher.deleted_at IS NULL')
      .andWhere('user.deleted_at IS NULL');

    // Filter by user status
    if (status !== undefined) {
      queryBuilder.andWhere('user.status = :status', { status });
    }

    // Search by name or email
    if (search !== undefined && search !== '') {
      queryBuilder.andWhere(
        `(user.first_name ILIKE :search
          OR user.last_name ILIKE :search
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
          ? 'teacher.rating'
          : 'teacher.created_at';
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    queryBuilder.orderBy(sortColumn, sortOrder).addOrderBy('teacher.id', sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const teachers = await queryBuilder.getMany();

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
      data: teachers.map((t) => this.mapToProfileWithDetails(t)),
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
   */
  public async findApprovedTeachersPublic(
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

    const query = this.publicTeacherQuery();
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
          ? 'teacher.rating'
          : 'teacher.created_at';
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    query.orderBy(sortColumn, sortOrder).addOrderBy('teacher.id', sortOrder);

    const total = await query.getCount();
    const profiles = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
    const totalPages = Math.ceil(total / limit);

    return {
      data: profiles.map((profile) => this.mapToPublicProfile(profile)),
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
   */
  public async findApprovedTeacherByIdPublic(id: string): Promise<PublicTeacherResponseDto> {
    const profile = await this.publicTeacherQuery()
      .andWhere('teacher.id = :id', { id })
      .getOne();

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${id} not found`, `المعلم بالمعرّف ${id} غير موجود`),
      );
    }

    return this.mapToPublicProfile(profile);
  }

  /** Query boundary for public teacher data: private User columns are never selected. */
  private publicTeacherQuery(): SelectQueryBuilder<TeacherProfile> {
    return this.teacherProfilesRepository
      .createQueryBuilder('teacher')
      .leftJoin('teacher.user', 'user')
      .leftJoin('teacher.subjects', 'subjects')
      .select([
        'teacher.id',
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
        'subjects.name_ar',
        'subjects.grade_level',
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

    return this.mapToProfileWithDetails(profile);
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
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${profileId} not found`, `المعلم بالمعرّف ${profileId} غير موجود`),
      );
    }

    if (profile.user.status === UserStatus.APPROVED) {
      throw new ConflictException(biBody('Teacher is already approved', 'المعلم معتمد بالفعل'));
    }

    // Update user status
    profile.user.status = UserStatus.APPROVED;
    profile.user.rejection_reason = null;

    await this.usersRepository.save(profile.user);

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

    return this.mapToProfileWithDetails(profile);
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
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${profileId} not found`, `المعلم بالمعرّف ${profileId} غير موجود`),
      );
    }

    if (profile.user.status === UserStatus.REJECTED) {
      throw new ConflictException(biBody('Teacher is already rejected', 'المعلم مرفوض بالفعل'));
    }

    // Update user status with rejection reason
    profile.user.status = UserStatus.REJECTED;
    profile.user.rejection_reason = dto.reason;

    await this.usersRepository.save(profile.user);

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

    return this.mapToProfileWithDetails(profile);
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

    return this.mapToProfileWithDetails(updatedProfile);
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

    const [lessonRows, orderRows] = await Promise.all([
      this.dataSource.query<Array<{ lessons_count: string }>>(
        `SELECT COUNT(*)::text AS lessons_count
           FROM lessons
          WHERE teacher_id = $1 AND deleted_at IS NULL`,
        [userId],
      ),
      // Paid orders are the canonical sale. `teacher_earning_minor` is the
      // commission-adjusted entitlement snapshotted onto the order at
      // finalization, so summing it needs no further arithmetic here.
      this.dataSource.query<Array<{ students_count: string; total_earnings_minor: string }>>(
        `SELECT COUNT(DISTINCT student_id)::text AS students_count,
                COALESCE(SUM(teacher_earning_minor), 0)::text AS total_earnings_minor
           FROM orders
          WHERE teacher_id = $1 AND status = 'paid'`,
        [userId],
      ),
    ]);

    return {
      lessonsCount: Number(lessonRows[0]?.lessons_count ?? 0),
      studentsCount: Number(orderRows[0]?.students_count ?? 0),
      /** Minor units (piastres), consistent with every other financial figure. */
      totalEarnings: Number(orderRows[0]?.total_earnings_minor ?? 0),
      averageRating: profile.rating,
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

  /**
   * Update teacher rating (called when a student rates)
   * Recalculates average rating
   */
  public async updateTeacherRating(profileId: string, newRating: number): Promise<void> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
    });

    if (!profile) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${profileId} not found`, `المعلم بالمعرّف ${profileId} غير موجود`),
      );
    }

    // Calculate new average rating
    const currentTotal = profile.rating * profile.total_ratings;
    const newTotalRatings = profile.total_ratings + 1;
    const newAverageRating = (currentTotal + newRating) / newTotalRatings;

    // Update profile
    profile.rating = Math.round(newAverageRating * 100) / 100; // Round to 2 decimal places
    profile.total_ratings = newTotalRatings;

    await this.teacherProfilesRepository.save(profile);
  }

  /**
   * Helper method to map TeacherProfile entity to response type
   */
  /**
   * Map a teacher profile to the sanitized, PII-free public projection.
   * Never include email/phone/parent_phone/status here.
   */
  private mapToPublicProfile(profile: TeacherProfile): PublicTeacherResponseDto {
    return toPublicTeacherResponse(profile, (value) => this.media.resolveThumbnailUrl(value));
  }

  private mapToProfileWithDetails(profile: TeacherProfile): TeacherProfileWithDetails {
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
      rating: profile.rating,
      total_ratings: profile.total_ratings,
      subjects: profile.subjects,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }
}
