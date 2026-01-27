import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  AssignSubjectsDto,
  RejectTeacherDto,
  TeacherFilterDto,
  UpdateTeacherProfileDto,
} from './dto';
import { TeacherProfile } from './entities/teacher-profile.entity';
import { In, Repository } from 'typeorm';

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
    parent_phone: string | null;
    profile_picture_url: string | null;
    status: UserStatus;
    rejection_reason: string | null;
    created_at: Date;
  };
  qualifications: string;
  years_of_experience: number;
  bio: string | null;
  rating: number;
  total_ratings: number;
  subjects: Subject[];
  created_at: Date;
  updated_at: Date;
}

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
  constructor(
    @InjectRepository(TeacherProfile)
    private readonly teacherProfilesRepository: Repository<TeacherProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
  ) {}

  /**
   * Get a teacher's own profile by user ID
   * Used by teachers to view their profile
   */
  public async findTeacherProfile(
    userId: string,
  ): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { user_id: userId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException('Teacher profile not found');
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
      throw new NotFoundException('Teacher profile not found');
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
        `Failed to reload teacher profile ${savedProfile.id}`,
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
    queryBuilder.orderBy(sortColumn, order.toUpperCase() as 'ASC' | 'DESC');

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
   * Get a single teacher by profile ID
   * Used by admin to view any teacher's details
   */
  public async findTeacherById(id: string): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(`Teacher with ID ${id} not found`);
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
  ): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(`Teacher with ID ${profileId} not found`);
    }

    if (profile.user.status === UserStatus.APPROVED) {
      throw new ConflictException('Teacher is already approved');
    }

    // Update user status
    profile.user.status = UserStatus.APPROVED;
    profile.user.rejection_reason = null;

    await this.usersRepository.save(profile.user);

    // TODO: Store approval notes in audit_logs table when implemented
    // Example: await this.auditLogService.log('TEACHER_APPROVED', profileId, notes);
    // TODO: Send notification to teacher about approval

    // Suppress unused variable warning until audit_logs table is implemented
    void notes;

    return this.mapToProfileWithDetails(profile);
  }

  /**
   * Reject a pending teacher
   * Sets user status to REJECTED with reason
   */
  public async rejectTeacher(
    profileId: string,
    dto: RejectTeacherDto,
  ): Promise<TeacherProfileWithDetails> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
      relations: ['user', 'subjects'],
    });

    if (!profile) {
      throw new NotFoundException(`Teacher with ID ${profileId} not found`);
    }

    if (profile.user.status === UserStatus.REJECTED) {
      throw new ConflictException('Teacher is already rejected');
    }

    // Update user status with rejection reason
    profile.user.status = UserStatus.REJECTED;
    profile.user.rejection_reason = dto.reason;

    await this.usersRepository.save(profile.user);

    // TODO: Send notification to teacher about rejection
    // TODO: Log audit trail for rejection action

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
      throw new NotFoundException(`Teacher with ID ${profileId} not found`);
    }

    // Validate all subject IDs exist
    const subjects = await this.subjectsRepository.findBy({
      id: In(dto.subjectIds),
    });

    if (subjects.length !== dto.subjectIds.length) {
      const foundIds = subjects.map((s) => s.id);
      const missingIds = dto.subjectIds.filter((id) => !foundIds.includes(id));
      throw new BadRequestException(
        `Subjects not found: ${missingIds.join(', ')}`,
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
        `Failed to reload teacher profile ${profileId}`,
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
      throw new NotFoundException(`Teacher with ID ${profileId} not found`);
    }

    // TODO: Implement actual stats queries when Lessons and Purchases modules are ready
    // For now, return placeholder stats
    return {
      lessonsCount: 0,
      studentsCount: 0,
      totalEarnings: 0,
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
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    if (user.role !== UserRole.TEACHER) {
      throw new BadRequestException('User must have TEACHER role');
    }

    // Check if profile already exists
    const existingProfile = await this.teacherProfilesRepository.findOne({
      where: { user_id: userId },
    });

    if (existingProfile) {
      throw new ConflictException(
        'Teacher profile already exists for this user',
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
   * Update teacher rating (called when a student rates)
   * Recalculates average rating
   */
  public async updateTeacherRating(
    profileId: string,
    newRating: number,
  ): Promise<void> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { id: profileId },
    });

    if (!profile) {
      throw new NotFoundException(`Teacher with ID ${profileId} not found`);
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
  private mapToProfileWithDetails(
    profile: TeacherProfile,
  ): TeacherProfileWithDetails {
    return {
      id: profile.id,
      user: {
        id: profile.user.id,
        name: profile.user.name,
        email: profile.user.email,
        phone: profile.user.phone,
        parent_phone: profile.user.parent_phone,
        profile_picture_url: profile.user.profile_picture_url,
        status: profile.user.status,
        rejection_reason: profile.user.rejection_reason,
        created_at: profile.user.created_at,
      },
      qualifications: profile.qualifications,
      years_of_experience: profile.years_of_experience,
      bio: profile.bio,
      rating: profile.rating,
      total_ratings: profile.total_ratings,
      subjects: profile.subjects,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }
}
