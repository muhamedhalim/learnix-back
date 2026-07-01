import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, SelectQueryBuilder } from 'typeorm';

import { VIDEO_URL_PATTERNS } from '../common/constants';
import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import {
  CreateLessonDto,
  LessonFilterDto,
  UpdateLessonDto,
  UpdateVimeoInfoDto,
} from './dto';
import {
  BunnyStreamService,
  BunnyVideoMetadata,
} from './bunny-stream.service';
import { Lesson } from './entities/lesson.entity';

/**
 * Response type for lesson with teacher and subject details
 */
export interface LessonWithDetails {
  id: string;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  teacher: {
    id: string;
    name: string;
    email: string;
    profile_picture_url: string | null;
  };
  subject: {
    id: string;
    name: string;
    grade_level: string;
  };
  thumbnail: string | null;
  // Primary video fields (Bunny.net)
  video_url: string | null;
  video_platform: 'bunny' | 'vimeo';
  bunny_video_id: string | null;
  bunny_library_id: string | null;
  bunny_video_status: string | null;
  video_width: number | null;
  video_height: number | null;
  video_thumbnail: string | null;
  video_size_bytes: number | null;
  // Legacy Vimeo fields (backward compatibility)
  vimeo_video_id: string | null;
  vimeo_embed_url: string | null;
  price: number;
  duration: number | null;
  is_group: boolean;
  available_for_days: number;
  students_count: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Summary stats for a lesson
 */
export interface LessonStats {
  purchaseCount: number;
  totalRevenue: number;
  averageRating: number;
}

@Injectable()
export class LessonsService {
  constructor(
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly bunnyStream: BunnyStreamService,
  ) {}

  /**
   * Create a new lesson
   * Only teachers can create lessons
   */
  public async create(
    teacherId: string,
    dto: CreateLessonDto,
  ): Promise<LessonWithDetails> {
    // Validate teacher exists and has correct role
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new NotFoundException(`Teacher with ID ${teacherId} not found`);
    }

    if (teacher.role !== UserRole.TEACHER) {
      throw new BadRequestException('Only teachers can create lessons');
    }

    // Validate subject exists
    const subject = await this.subjectsRepository.findOne({
      where: { id: dto.subject_id },
    });

    if (!subject) {
      throw new NotFoundException(
        `Subject with ID ${dto.subject_id} not found`,
      );
    }

    // Generate Vimeo embed URL if video ID provided
    let vimeoEmbedUrl: string | null = null;
    if (dto.vimeo_video_id !== undefined && dto.vimeo_video_id !== '') {
      vimeoEmbedUrl = this.generateVimeoEmbedUrl(dto.vimeo_video_id);
    }

    // Create lesson
    const lesson = this.lessonsRepository.create({
      title: dto.title,
      title_ar: dto.title_ar,
      description: dto.description ?? null,
      description_ar: dto.description_ar ?? null,
      teacher_id: teacherId,
      subject_id: dto.subject_id,
      thumbnail: dto.thumbnail ?? null,
      vimeo_video_id: dto.vimeo_video_id ?? null,
      vimeo_embed_url: vimeoEmbedUrl,
      price: dto.price,
      duration: dto.duration ?? null,
      is_group: dto.is_group ?? false,
      available_for_days: dto.available_for_days ?? 7,
      students_count: 0,
    });

    const savedLesson = await this.lessonsRepository.save(lesson);

    // Reload with relations
    const fullLesson = await this.lessonsRepository.findOne({
      where: { id: savedLesson.id },
      relations: ['teacher', 'subject'],
    });

    if (!fullLesson) {
      throw new NotFoundException('Failed to load created lesson');
    }

    return this.mapToLessonWithDetails(fullLesson);
  }

  /**
   * Find all lessons with filtering, sorting, and pagination
   */
  public async findAll(
    filter: LessonFilterDto,
  ): Promise<PaginatedResponse<LessonWithDetails>> {
    const { page = 1, limit = 20 } = filter;

    const queryBuilder = this.lessonsRepository
      .createQueryBuilder('lesson')
      .leftJoinAndSelect('lesson.teacher', 'teacher')
      .leftJoinAndSelect('lesson.subject', 'subject')
      .where('lesson.deleted_at IS NULL');

    // Apply various filters
    this.applyAllFilters(queryBuilder, filter);

    // Apply sorting
    this.applySorting(queryBuilder, filter.sortBy, filter.order);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const lessons = await queryBuilder.getMany();

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
      data: lessons.map((l) => this.mapToLessonWithDetails(l)),
      meta,
    };
  }

  /**
   * Applies all filters to the lesson query builder
   */
  private applyAllFilters(
    queryBuilder: SelectQueryBuilder<Lesson>,
    filter: LessonFilterDto,
  ): void {
    const {
      search,
      teacher_id: teacherId,
      subject_id: subjectId,
      is_group: isGroup,
      minPrice,
      maxPrice,
    } = filter;

    if (teacherId !== undefined && teacherId !== '') {
      queryBuilder.andWhere('lesson.teacher_id = :teacherId', { teacherId });
    }

    if (subjectId !== undefined && subjectId !== '') {
      queryBuilder.andWhere('lesson.subject_id = :subjectId', { subjectId });
    }

    if (isGroup !== undefined) {
      queryBuilder.andWhere('lesson.is_group = :isGroup', { isGroup });
    }

    if (minPrice !== undefined) {
      queryBuilder.andWhere('lesson.price >= :minPrice', { minPrice });
    }

    if (maxPrice !== undefined) {
      queryBuilder.andWhere('lesson.price <= :maxPrice', { maxPrice });
    }

    if (search !== undefined && search !== '') {
      queryBuilder.andWhere(
        '(lesson.title ILIKE :search OR lesson.title_ar ILIKE :search)',
        { search: `%${search}%` },
      );
    }
  }

  /**
   * Applies sorting to the lesson query builder
   */
  private applySorting(
    queryBuilder: SelectQueryBuilder<Lesson>,
    sortBy?: string,
    order: 'asc' | 'desc' = 'desc',
  ): void {
    const sortColumn =
      sortBy === 'price'
        ? 'lesson.price'
        : sortBy === 'title'
          ? 'lesson.title'
          : sortBy === 'students_count'
            ? 'lesson.students_count'
            : 'lesson.created_at';

    queryBuilder.orderBy(sortColumn, order.toUpperCase() as 'ASC' | 'DESC');
  }

  /**
   * Find lessons by teacher
   */
  public async findByTeacher(
    teacherId: string,
    filter: Omit<LessonFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<LessonWithDetails>> {
    return await this.findAll({
      ...filter,
      teacher_id: teacherId,
    });
  }

  /**
   * Find lessons by subject
   */
  public async findBySubject(
    subjectId: string,
    filter: Omit<LessonFilterDto, 'subject_id'>,
  ): Promise<PaginatedResponse<LessonWithDetails>> {
    return await this.findAll({
      ...filter,
      subject_id: subjectId,
    });
  }

  /**
   * Find a single lesson by ID
   */
  public async findOne(id: string): Promise<LessonWithDetails> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id },
      relations: ['teacher', 'subject'],
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${id} not found`);
    }

    return this.mapToLessonWithDetails(lesson);
  }

  /**
   * Update a lesson
   * Only the owner teacher can update
   */
  public async update(
    lessonId: string,
    teacherId: string,
    dto: UpdateLessonDto,
  ): Promise<LessonWithDetails> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
      relations: ['teacher', 'subject'],
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own lessons');
    }

    // Validate subject change
    await this.validateSubjectChange(dto, lesson);

    // Apply updates
    this.applyLessonUpdates(lesson, dto);

    const savedLesson = await this.lessonsRepository.save(lesson);

    // Reload with relations
    const fullLesson = await this.lessonsRepository.findOne({
      where: { id: savedLesson.id },
      relations: ['teacher', 'subject'],
    });

    if (!fullLesson) {
      throw new NotFoundException('Failed to load updated lesson');
    }

    return this.mapToLessonWithDetails(fullLesson);
  }

  private async validateSubjectChange(
    dto: UpdateLessonDto,
    lesson: Lesson,
  ): Promise<void> {
    if (dto.subject_id !== undefined && dto.subject_id !== lesson.subject_id) {
      const subject = await this.subjectsRepository.findOne({
        where: { id: dto.subject_id },
      });
      if (!subject) {
        throw new NotFoundException(
          `Subject with ID ${dto.subject_id} not found`,
        );
      }
    }
  }

  private applyLessonUpdates(lesson: Lesson, dto: UpdateLessonDto): void {
    const updates: Partial<Lesson> = {};
    if (dto.title !== undefined) {
      updates.title = dto.title;
    }
    if (dto.title_ar !== undefined) {
      updates.title_ar = dto.title_ar;
    }
    if (dto.description !== undefined) {
      updates.description = dto.description;
    }
    if (dto.description_ar !== undefined) {
      updates.description_ar = dto.description_ar;
    }
    if (dto.subject_id !== undefined) {
      updates.subject_id = dto.subject_id;
    }
    if (dto.price !== undefined) {
      updates.price = dto.price;
    }
    if (dto.thumbnail !== undefined) {
      updates.thumbnail = dto.thumbnail;
    }
    if (dto.is_group !== undefined) {
      updates.is_group = dto.is_group;
    }
    if (dto.available_for_days !== undefined) {
      updates.available_for_days = dto.available_for_days;
    }
    Object.assign(lesson, updates);
  }

  /**
   * Delete a lesson (soft delete)
   * Only the owner teacher can delete
   */
  public async delete(lessonId: string, teacherId: string): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only delete your own lessons');
    }

    // Clean up the Bunny Stream asset so deleted lessons don't leak storage.
    if (lesson.bunny_video_id) {
      await this.bunnyStream.deleteVideo(lesson.bunny_video_id);
    }

    await this.lessonsRepository.softDelete(lessonId);
  }

  /**
   * Admin force delete a lesson
   */
  public async adminDelete(lessonId: string): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    await this.lessonsRepository.softDelete(lessonId);
  }

  /**
   * Find teacher's own lessons
   */
  public async findMyLessons(
    teacherId: string,
    filter: Omit<LessonFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<LessonWithDetails>> {
    return await this.findAll({
      ...filter,
      teacher_id: teacherId,
    });
  }

  /**
   * Update Vimeo info for a lesson
   * Only the owner teacher can update
   */
  public async updateVimeoInfo(
    lessonId: string,
    teacherId: string,
    dto: UpdateVimeoInfoDto,
  ): Promise<LessonWithDetails> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
      relations: ['teacher', 'subject'],
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own lessons');
    }

    // Update Vimeo fields
    lesson.vimeo_video_id = dto.vimeo_video_id;
    lesson.vimeo_embed_url =
      dto.vimeo_embed_url ?? this.generateVimeoEmbedUrl(dto.vimeo_video_id);
    if (dto.duration !== undefined) {
      lesson.duration = dto.duration;
    }

    const savedLesson = await this.lessonsRepository.save(lesson);

    // Reload with relations
    const fullLesson = await this.lessonsRepository.findOne({
      where: { id: savedLesson.id },
      relations: ['teacher', 'subject'],
    });

    if (!fullLesson) {
      throw new NotFoundException('Failed to load updated lesson');
    }

    return this.mapToLessonWithDetails(fullLesson);
  }

  /**
   * Generate Vimeo embed URL from video ID
   * Legacy method for backward compatibility with existing Vimeo videos
   */
  public generateVimeoEmbedUrl(vimeoVideoId: string): string {
    return `https://player.vimeo.com/video/${vimeoVideoId}`;
  }

  /**
   * Update lesson video URL (Bunny.net - Primary)
   * Extracts library_id and video_id from URL and stores them separately
   */
  public async updateVideoUrl(
    lessonId: string,
    teacherId: string,
    videoUrl: string,
    duration?: number,
  ): Promise<{
    message: string;
    video_url: string;
    video_platform: string;
    bunny_video_id: string;
    bunny_library_id: string;
  }> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own lessons');
    }

    // Validate Bunny.net URL format using regex from constants
    const match = videoUrl.match(VIDEO_URL_PATTERNS.BUNNY);

    if (match?.[1] === undefined || match[2] === undefined) {
      throw new BadRequestException(
        'Invalid Bunny.net URL format. Expected: https://iframe.mediadelivery.net/embed/{library_id}/{video_id}',
      );
    }

    // Extract library ID and video ID from URL
    const libraryId = match[1];
    const videoId = match[2];

    // Update lesson with Bunny.net video info
    lesson.video_url = videoUrl;
    lesson.video_platform = 'bunny';
    lesson.bunny_video_id = videoId;
    lesson.bunny_library_id = libraryId;
    if (duration !== undefined) {
      lesson.duration = duration;
    }

    await this.lessonsRepository.save(lesson);

    return {
      message: 'Video URL updated successfully',
      video_url: videoUrl,
      video_platform: 'bunny',
      bunny_video_id: videoId,
      bunny_library_id: libraryId,
    };
  }

  /**
   * Update lesson video URL (Vimeo - Legacy)
   * @deprecated Use updateVideoUrl() with Bunny.net URLs instead
   */
  public async updateVimeoUrl(
    lessonId: string,
    teacherId: string,
    vimeoUrl: string,
    duration?: number,
  ): Promise<{
    message: string;
    video_url: string;
    video_platform: string;
  }> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own lessons');
    }

    // Validate Vimeo URL format
    if (!VIDEO_URL_PATTERNS.VIMEO.test(vimeoUrl)) {
      throw new BadRequestException(
        'Invalid Vimeo URL format. Please provide a valid Vimeo video URL.',
      );
    }

    // Update lesson with Vimeo video info
    lesson.video_url = vimeoUrl;
    lesson.video_platform = 'vimeo';
    if (duration !== undefined) {
      lesson.duration = duration;
    }

    await this.lessonsRepository.save(lesson);

    return {
      message: 'Vimeo URL updated successfully (legacy)',
      video_url: vimeoUrl,
      video_platform: 'vimeo',
    };
  }

  /**
   * Get lesson statistics
   * Returns purchase count, revenue, etc.
   */
  public async getLessonStats(lessonId: string): Promise<LessonStats> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // TODO: Implement actual stats queries when Purchases module is ready
    // For now, return placeholder stats
    return {
      purchaseCount: lesson.students_count,
      totalRevenue: lesson.price * lesson.students_count,
      averageRating: 0,
    };
  }

  /**
   * Increment students count when a lesson is purchased
   * Called internally by Purchases module
   */
  public async incrementStudentsCount(lessonId: string): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    lesson.students_count += 1;
    await this.lessonsRepository.save(lesson);
  }

  /**
   * Validate if a student has access to a lesson
   * Placeholder for Purchases module integration
   */
  public async validateAccess(
    lessonId: string,
  ): Promise<{ hasAccess: boolean; expiresAt: Date | null }> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

    // TODO: Implement actual access check when Purchases module is ready
    // For now, return no access
    // This will be updated to check lesson_purchases table
    return {
      hasAccess: false,
      expiresAt: null,
    };
  }

  /* ============================================================
   * Bunny Stream — secure direct (TUS) upload orchestration
   * ============================================================ */

  private async findOwnedLesson(
    lessonId: string,
    teacherId: string,
  ): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own lessons');
    }
    return lesson;
  }

  /**
   * Provision a Bunny Stream video for a lesson and return short-lived TUS
   * credentials for the client to upload directly to Bunny. If the lesson
   * already has a Bunny video, the previous asset is deleted first (replace),
   * so no orphaned videos accumulate.
   */
  public async createBunnyUpload(
    lessonId: string,
    teacherId: string,
    title?: string,
  ): Promise<{
    videoId: string;
    libraryId: string;
    tus: ReturnType<BunnyStreamService['createTusCredentials']>;
  }> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);

    // Replace: remove the previous Bunny video so we never leak assets.
    if (lesson.bunny_video_id) {
      await this.bunnyStream.deleteVideo(lesson.bunny_video_id);
    }

    const { videoId, libraryId } = await this.bunnyStream.createVideo(
      title ?? lesson.title,
    );

    lesson.video_platform = 'bunny';
    lesson.bunny_video_id = videoId;
    lesson.bunny_library_id = libraryId;
    lesson.bunny_video_status = 'created';
    lesson.video_url = this.bunnyStream.buildEmbedUrl(videoId);
    // Reset stale metadata from any replaced video.
    lesson.video_thumbnail = null;
    lesson.video_width = null;
    lesson.video_height = null;
    lesson.video_size_bytes = null;
    await this.lessonsRepository.save(lesson);

    return {
      videoId,
      libraryId,
      tus: this.bunnyStream.createTusCredentials(videoId),
    };
  }

  /**
   * Fetch the current encoding state from Bunny and persist it on the lesson
   * (duration, resolution, poster, size, status). Used for polling after upload.
   */
  public async refreshBunnyStatus(
    lessonId: string,
    teacherId: string,
  ): Promise<BunnyVideoMetadata & { lessonId: string }> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    if (!lesson.bunny_video_id) {
      throw new BadRequestException('This lesson has no Bunny Stream video.');
    }

    const meta = await this.bunnyStream.getVideo(lesson.bunny_video_id);

    lesson.bunny_video_status = meta.status;
    lesson.video_url = meta.embedUrl;
    if (meta.durationSeconds != null) lesson.duration = meta.durationSeconds;
    if (meta.width != null) lesson.video_width = meta.width;
    if (meta.height != null) lesson.video_height = meta.height;
    if (meta.sizeBytes != null) lesson.video_size_bytes = meta.sizeBytes;
    if (meta.thumbnailUrl) lesson.video_thumbnail = meta.thumbnailUrl;
    await this.lessonsRepository.save(lesson);

    return { ...meta, lessonId: lesson.id };
  }

  /**
   * Mark the upload as transferred (client finished the TUS PATCH). We flip the
   * stored status to 'processing' so the UI reflects Bunny's transcoding stage
   * immediately, then polling takes over.
   */
  public async markBunnyUploaded(
    lessonId: string,
    teacherId: string,
  ): Promise<{ status: string }> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    if (lesson.bunny_video_status === 'created') {
      lesson.bunny_video_status = 'processing';
      await this.lessonsRepository.save(lesson);
    }
    return { status: lesson.bunny_video_status ?? 'processing' };
  }

  /** Remove the lesson's Bunny video (from Bunny + clear stored metadata). */
  public async removeBunnyVideo(
    lessonId: string,
    teacherId: string,
  ): Promise<void> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    if (lesson.bunny_video_id) {
      await this.bunnyStream.deleteVideo(lesson.bunny_video_id);
    }
    lesson.bunny_video_id = null;
    lesson.bunny_library_id = null;
    lesson.bunny_video_status = null;
    lesson.video_url = null;
    lesson.video_thumbnail = null;
    lesson.video_width = null;
    lesson.video_height = null;
    lesson.video_size_bytes = null;
    await this.lessonsRepository.save(lesson);
  }

  /**
   * Guard: a lesson may only be published once its Bunny video has finished
   * encoding. Lessons with no Bunny video are unaffected.
   */
  public assertVideoReadyForPublish(lesson: Lesson): void {
    if (lesson.bunny_video_id && lesson.bunny_video_status !== 'ready') {
      throw new BadRequestException(
        'Video is still processing. You can publish once it is ready.',
      );
    }
  }

  /**
   * Helper method to map Lesson entity to response type
   */
  private mapToLessonWithDetails(lesson: Lesson): LessonWithDetails {
    return {
      id: lesson.id,
      title: lesson.title,
      title_ar: lesson.title_ar,
      description: lesson.description,
      description_ar: lesson.description_ar,
      teacher: {
        id: lesson.teacher.id,
        name: lesson.teacher.name,
        email: lesson.teacher.email,
        profile_picture_url: lesson.teacher.profile_picture_url,
      },
      subject: {
        id: lesson.subject.id,
        name: lesson.subject.name,
        grade_level: lesson.subject.grade_level,
      },
      thumbnail: lesson.thumbnail,
      // Primary video fields (Bunny.net)
      video_url: lesson.video_url,
      video_platform: lesson.video_platform,
      bunny_video_id: lesson.bunny_video_id,
      bunny_library_id: lesson.bunny_library_id,
      bunny_video_status: lesson.bunny_video_status,
      video_width: lesson.video_width,
      video_height: lesson.video_height,
      video_thumbnail: lesson.video_thumbnail,
      video_size_bytes:
        lesson.video_size_bytes == null
          ? null
          : Number(lesson.video_size_bytes),
      // Legacy Vimeo fields (backward compatibility)
      vimeo_video_id: lesson.vimeo_video_id,
      vimeo_embed_url: lesson.vimeo_embed_url,
      price: lesson.price,
      duration: lesson.duration,
      is_group: lesson.is_group,
      available_for_days: lesson.available_for_days,
      students_count: lesson.students_count,
      created_at: lesson.created_at,
      updated_at: lesson.updated_at,
    };
  }
}
