import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, SelectQueryBuilder } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import {
  CreateLessonDto,
  LessonFilterDto,
  PublicLessonResponseDto,
  toPublicLessonResponse,
  UpdateLessonDto,
} from './dto';
import { PaymentsService } from '../payments/services/payments.service';
import { BunnyStreamService, BunnyVideoMetadata } from './bunny-stream.service';
import { Lesson } from './entities/lesson.entity';
import { LessonStatus } from './entities/lesson-status.enum';

/**
 * Response type for lesson with teacher and subject details
 */
export interface LessonWithDetails {
  id: string;
  title: string;
  description: string | null;
  teacher: {
    id: string;
    name: string;
    profile_picture_url: string | null;
  };
  subject: {
    id: string;
    name: string;
    grade_level: string;
  };
  thumbnail: string | null;
  /** Public URL for `thumbnail`, always routed through the media proxy — never a raw storage URL. */
  thumbnail_url: string | null;
  video_url: string | null;
  video_platform: 'bunny';
  bunny_video_id: string | null;
  bunny_library_id: string | null;
  bunny_video_status: string | null;
  video_width: number | null;
  video_height: number | null;
  video_thumbnail: string | null;
  video_size_bytes: number | null;
  price: number;
  duration: number | null;
  is_group: boolean;
  available_for_days: number;
  students_count: number;
  status: LessonStatus;
  created_at: Date;
  updated_at: Date;
}
export interface LessonStats {
  purchaseCount: number;
  totalRevenue: number;
  averageRating: number;
}
interface LessonListRawRow {
  id: string;
  title: string;
  description: string | null;
  teacher_id: string;
  teacher_name: string;
  teacher_profile_picture_url: string | null;
  subject_id: string;
  subject_name: string;
  subject_grade_level: string;
  thumbnail: string | null;
  video_url: string | null;
  video_platform: 'bunny';
  bunny_video_id: string | null;
  bunny_library_id: string | null;
  bunny_video_status: string | null;
  video_width: number | null;
  video_height: number | null;
  video_thumbnail: string | null;
  video_size_bytes: string | number | null;
  price: string | number;
  duration: number | null;
  is_group: boolean;
  available_for_days: number;
  students_count: number;
  status: LessonStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly bunnyStream: BunnyStreamService,
    private readonly paymentsService: PaymentsService,
    private readonly media: MediaService,
  ) {}

  /**
   * Create a new lesson
   * Only teachers can create lessons
   */
  public async create(teacherId: string, dto: CreateLessonDto): Promise<LessonWithDetails> {
    // Validate teacher exists and has correct role
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new NotFoundException(
        biBody(`Teacher with ID ${teacherId} not found`, `المعلم بالمعرّف ${teacherId} غير موجود`),
      );
    }

    if (teacher.role !== UserRole.TEACHER) {
      throw new BadRequestException(
        biBody('Only teachers can create lessons', 'المعلمون فقط يمكنهم إنشاء الدروس'),
      );
    }

    // Validate subject exists
    const subject = await this.subjectsRepository.findOne({
      where: { id: dto.subject_id },
    });

    if (!subject) {
      throw new NotFoundException(
        biBody(
          `Subject with ID ${dto.subject_id} not found`,
          `المادة بالمعرّف ${dto.subject_id} غير موجودة`,
        ),
      );
    }
    // Create lesson
    const lesson = this.lessonsRepository.create({
      title: dto.title,
      description: dto.description ?? null,
      teacher_id: teacherId,
      subject_id: dto.subject_id,
      thumbnail: dto.thumbnail ?? null,
      price: dto.price,
      duration: dto.duration ?? null,
      is_group: dto.is_group ?? false,
      is_free_preview: dto.is_free_preview ?? false,
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
      throw new NotFoundException(
        biBody('Failed to load created lesson', 'فشل تحميل الدرس الذي تم إنشاؤه'),
      );
    }

    return this.mapToLessonWithDetails(fullLesson);
  }

  /**
   * Find all lessons with filtering, sorting, and pagination
   */
  public async findAll(filter: LessonFilterDto): Promise<PaginatedResponse<LessonWithDetails>> {
    return await this.findAllWithVisibility(filter, false);
  }

  /** Public catalogue: published lessons only and an explicit safe response. */
  public async findAllPublic(
    filter: LessonFilterDto,
  ): Promise<PaginatedResponse<PublicLessonResponseDto>> {
    const result = await this.findAllWithVisibility(filter, true);
    const data: PublicLessonResponseDto[] = [];
    for (const lesson of result.data) {
      data.push(toPublicLessonResponse(lesson, (value) => this.media.resolveThumbnailUrl(value)));
    }
    return { data, meta: result.meta };
  }

  private async findAllWithVisibility(
    filter: LessonFilterDto,
    publishedOnly: boolean,
  ): Promise<PaginatedResponse<LessonWithDetails>> {
    const { page = 1, limit = 20 } = filter;

    const baseQuery = this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.deleted_at IS NULL');

    if (publishedOnly) {
      baseQuery.andWhere('lesson.status = :publicStatus', {
        publicStatus: LessonStatus.PUBLISHED,
      });
    }

    this.applyAllFilters(baseQuery, filter);

    const skip = (page - 1) * limit;
    const countQuery = baseQuery.clone();
    const pageIdsQuery = baseQuery.clone().select('lesson.id');
    this.applySorting(pageIdsQuery, filter.sortBy, filter.order);
    pageIdsQuery.offset(skip).limit(limit);

    // Select the page before joining or projecting relationship data. This
    // prevents deep offsets from hydrating rows that the database discards.
    const listQuery = this.lessonsRepository
      .createQueryBuilder('lesson')
      .leftJoin('lesson.teacher', 'teacher')
      .leftJoin('lesson.subject', 'subject')
      .select('lesson.id', 'id')
      .addSelect('lesson.title', 'title')
      .addSelect('lesson.description', 'description')
      .addSelect('teacher.id', 'teacher_id')
      .addSelect('teacher.name', 'teacher_name')
      .addSelect('teacher.profile_picture_url', 'teacher_profile_picture_url')
      .addSelect('subject.id', 'subject_id')
      .addSelect('subject.name', 'subject_name')
      .addSelect('subject.grade_level', 'subject_grade_level')
      .addSelect('lesson.thumbnail', 'thumbnail')
      .addSelect('lesson.video_url', 'video_url')
      .addSelect('lesson.video_platform', 'video_platform')
      .addSelect('lesson.bunny_video_id', 'bunny_video_id')
      .addSelect('lesson.bunny_library_id', 'bunny_library_id')
      .addSelect('lesson.bunny_video_status', 'bunny_video_status')
      .addSelect('lesson.video_width', 'video_width')
      .addSelect('lesson.video_height', 'video_height')
      .addSelect('lesson.video_thumbnail', 'video_thumbnail')
      .addSelect('lesson.video_size_bytes', 'video_size_bytes')
      .addSelect('lesson.price', 'price')
      .addSelect('lesson.duration', 'duration')
      .addSelect('lesson.is_group', 'is_group')
      .addSelect('lesson.available_for_days', 'available_for_days')
      .addSelect('lesson.students_count', 'students_count')
      .addSelect('lesson.status', 'status')
      .addSelect('lesson.created_at', 'created_at')
      .addSelect('lesson.updated_at', 'updated_at')
      .where(`lesson.id IN (${pageIdsQuery.getQuery()})`)
      .setParameters(pageIdsQuery.getParameters());
    this.applySorting(listQuery, filter.sortBy, filter.order);

    const [total, rows] = await Promise.all([
      countQuery.getCount(),
      listQuery.getRawMany<LessonListRawRow>(),
    ]);

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    const data: LessonWithDetails[] = [];
    for (const row of rows) {
      data.push(this.mapListRowToLessonWithDetails(row));
    }

    return { data, meta };
  }

  /**
   * Applies all filters to the lesson query builder
   */
  private applyAllFilters(queryBuilder: SelectQueryBuilder<Lesson>, filter: LessonFilterDto): void {
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
      queryBuilder.andWhere('lesson.title ILIKE :search', {
        search: `%${search}%`,
      });
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

    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    queryBuilder.orderBy(sortColumn, sortOrder).addOrderBy('lesson.id', sortOrder);
    queryBuilder.addOrderBy('lesson.id', order.toUpperCase() as 'ASC' | 'DESC');
  }

  private mapListRowToLessonWithDetails(row: LessonListRawRow): LessonWithDetails {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      teacher: {
        id: row.teacher_id,
        name: row.teacher_name,
        profile_picture_url: row.teacher_profile_picture_url,
      },
      subject: {
        id: row.subject_id,
        name: row.subject_name,
        grade_level: row.subject_grade_level,
      },
      thumbnail: row.thumbnail,
      thumbnail_url: this.media.resolveThumbnailUrl(row.thumbnail),
      video_url: row.video_url,
      video_platform: row.video_platform,
      bunny_video_id: row.bunny_video_id,
      bunny_library_id: row.bunny_library_id,
      bunny_video_status: row.bunny_video_status,
      video_width: row.video_width,
      video_height: row.video_height,
      video_thumbnail: row.video_thumbnail,
      video_size_bytes: row.video_size_bytes === null ? null : Number(row.video_size_bytes),
      price: Number(row.price),
      duration: row.duration,
      is_group: row.is_group,
      available_for_days: row.available_for_days,
      students_count: row.students_count,
      status: row.status,
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    };
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

  public async findByTeacherPublic(
    teacherId: string,
    filter: Omit<LessonFilterDto, 'teacher_id'>,
  ): Promise<PaginatedResponse<PublicLessonResponseDto>> {
    return await this.findAllPublic({ ...filter, teacher_id: teacherId });
  }

  public async findBySubjectPublic(
    subjectId: string,
    filter: Omit<LessonFilterDto, 'subject_id'>,
  ): Promise<PaginatedResponse<PublicLessonResponseDto>> {
    return await this.findAllPublic({ ...filter, subject_id: subjectId });
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
      throw new NotFoundException(
        biBody(`Lesson with ID ${id} not found`, `الدرس بالمعرّف ${id} غير موجود`),
      );
    }

    return this.mapToLessonWithDetails(lesson);
  }

  public async findOnePublic(id: string): Promise<PublicLessonResponseDto> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id, status: LessonStatus.PUBLISHED },
      relations: ['teacher', 'subject'],
    });

    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'Lesson not found'));
    }

    return toPublicLessonResponse(this.mapToLessonWithDetails(lesson), (value) =>
      this.media.resolveThumbnailUrl(value),
    );
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
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only update your own lessons', 'يمكنك تحديث دروسك الخاصة فقط'),
      );
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
      throw new NotFoundException(
        biBody('Failed to load updated lesson', 'فشل تحميل الدرس المُحدَّث'),
      );
    }

    return this.mapToLessonWithDetails(fullLesson);
  }

  private async validateSubjectChange(dto: UpdateLessonDto, lesson: Lesson): Promise<void> {
    if (dto.subject_id !== undefined && dto.subject_id !== lesson.subject_id) {
      const subject = await this.subjectsRepository.findOne({
        where: { id: dto.subject_id },
      });
      if (!subject) {
        throw new NotFoundException(
          biBody(
            `Subject with ID ${dto.subject_id} not found`,
            `المادة بالمعرّف ${dto.subject_id} غير موجودة`,
          ),
        );
      }
    }
  }

  private applyLessonUpdates(lesson: Lesson, dto: UpdateLessonDto): void {
    const updates: Partial<Lesson> = {};
    if (dto.title !== undefined) {
      updates.title = dto.title;
    }
    if (dto.description !== undefined) {
      updates.description = dto.description;
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
    if (dto.is_free_preview !== undefined) {
      updates.is_free_preview = dto.is_free_preview;
    }
    if (dto.available_for_days !== undefined) {
      updates.available_for_days = dto.available_for_days;
    }
    if (dto.duration !== undefined) {
      updates.duration = dto.duration;
    }
    if (dto.status !== undefined) {
      // Publishing requires the Bunny video (if any) to be fully encoded.
      if (dto.status === LessonStatus.PUBLISHED) {
        this.assertVideoReadyForPublish(lesson);
      }
      updates.status = dto.status;
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
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }

    // Verify ownership
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only delete your own lessons', 'يمكنك حذف دروسك الخاصة فقط'),
      );
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
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
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
   * Get lesson statistics
   * Returns purchase count, revenue, etc.
   */
  public async getLessonStats(lessonId: string): Promise<LessonStats> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
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
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }

    lesson.students_count += 1;
    await this.lessonsRepository.save(lesson);
  }

  /* ============================================================
   * Bunny Stream — secure direct (TUS) upload orchestration
   * ============================================================ */

  private async findOwnedLesson(lessonId: string, teacherId: string): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only update your own lessons', 'يمكنك تحديث دروسك الخاصة فقط'),
      );
    }
    return lesson;
  }

  /**
   * Uploads (or replaces) a lesson's video. Replacement ordering is
   * deliberately safe: the NEW video is created and fully uploaded to Bunny
   * *before* the lesson is touched or the OLD video is deleted. If Bunny
   * fails at any point up to and including the upload, the lesson keeps
   * whatever video it had before this call — it is never left video-less
   * because of a Bunny outage. The old asset is only removed after the new
   * one is confirmed live on the lesson, and that cleanup is best-effort
   * (BunnyStreamService.deleteVideo never throws — 404 counts as already
   * deleted, and any other failure is logged, not raised) so a cleanup
   * hiccup can never revert or block the successful replacement.
   */
  public async uploadBunnyVideo(
    lessonId: string,
    teacherId: string,
    file: { buffer: Buffer; originalname: string; size: number },
    title?: string,
  ): Promise<{ videoId: string; libraryId: string; status: string }> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    const previousVideoId = lesson.bunny_video_id;

    const { videoId, libraryId } = await this.bunnyStream.createVideo(
      title ?? file.originalname ?? lesson.title,
    );
    this.logger.log(
      `Lesson ${lessonId}: created Bunny video ${videoId} (library ${libraryId}), starting upload` +
        (previousVideoId ? ` (replacing ${previousVideoId})` : ''),
    );

    try {
      await this.bunnyStream.uploadVideo(videoId, file.buffer);
    } catch (err) {
      // The new asset never received bytes and was never linked to the
      // lesson — clean it up and leave any existing video untouched.
      this.logger.warn(`Lesson ${lessonId}: upload to Bunny video ${videoId} failed, cleaning up`);
      await this.bunnyStream.deleteVideo(videoId);
      throw err;
    }

    // Bytes delivered — link the lesson to the new video. Bunny now encodes;
    // status polling (refreshBunnyStatus) takes over from here.
    lesson.video_platform = 'bunny';
    lesson.bunny_video_id = videoId;
    lesson.bunny_library_id = libraryId;
    lesson.bunny_video_status = 'processing';
    lesson.video_url = this.bunnyStream.buildEmbedUrl(videoId);
    lesson.video_thumbnail = null;
    lesson.video_width = null;
    lesson.video_height = null;
    lesson.video_size_bytes = file.size;
    await this.lessonsRepository.save(lesson);

    if (previousVideoId && previousVideoId !== videoId) {
      this.logger.log(`Lesson ${lessonId}: replacement live, queuing cleanup of ${previousVideoId}`);
      await this.bunnyStream.deleteVideo(previousVideoId);
    }

    return { videoId, libraryId, status: 'processing' };
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
      throw new BadRequestException(
        biBody(
          'This lesson has no Bunny Stream video.',
          'لا يحتوي هذا الدرس على فيديو Bunny Stream.',
        ),
      );
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

  /** Remove the lesson's Bunny video (from Bunny + clear stored metadata). */
  public async removeBunnyVideo(lessonId: string, teacherId: string): Promise<void> {
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
   * Single viewer-access policy for protected lesson content (video playback,
   * attachments, notes): the owning teacher, any admin, or a student with an
   * active lesson purchase / package enrolment. Returns the lesson so callers
   * avoid a second fetch.
   */
  public async assertViewerAccess(lessonId: string, userId: string, role: string): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }

    const isOwner = lesson.teacher_id === userId;
    const isAdmin = role === UserRole.ADMIN;
    const hasAccess =
      isOwner || isAdmin || (await this.paymentsService.hasLessonPlaybackAccess(userId, lessonId));

    if (!hasAccess) {
      throw new ForbiddenException(
        biBody(
          'You must enrol in this course to access this lesson.',
          'يجب أن تكون مسجّلاً في هذه الدورة للوصول إلى هذا الدرس.',
        ),
      );
    }
    return lesson;
  }

  /**
   * Issue a short-lived, token-signed playback URL for a lesson's video.
   * Access is gated by {@link assertViewerAccess}; the Bunny Stream API/token
   * keys never leave the server — only the signed URL does.
   */
  public async getSignedPlaybackUrl(
    lessonId: string,
    userId: string,
    role: string,
    ttlSeconds = 60 * 60,
  ): Promise<{ signedUrl: string; expiresIn: number }> {
    const lesson = await this.assertViewerAccess(lessonId, userId, role);
    if (!lesson.bunny_video_id || lesson.bunny_video_status !== 'ready') {
      throw new BadRequestException(
        biBody('This lesson has no ready video.', 'لا يوجد لهذا الدرس فيديو جاهز.'),
      );
    }

    const signedUrl = this.bunnyStream.generateSignedEmbedUrl(lesson.bunny_video_id, ttlSeconds);
    if (!signedUrl) {
      throw new ServiceUnavailableException(
        biBody(
          'Secure video playback is not configured on the server.',
          'التشغيل الآمن للفيديو غير مُهيَّأ على الخادم.',
        ),
      );
    }

    return { signedUrl, expiresIn: ttlSeconds };
  }

  /**
   * Guard: a lesson may only be published once its Bunny video has finished
   * encoding. Lessons with no Bunny video are unaffected.
   */
  public assertVideoReadyForPublish(lesson: Lesson): void {
    if (lesson.bunny_video_id && lesson.bunny_video_status !== 'ready') {
      throw new BadRequestException(
        biBody(
          'Video is still processing. You can publish once it is ready.',
          'الفيديو ما زال قيد المعالجة. يمكنك النشر بمجرد أن يصبح جاهزًا.',
        ),
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
      description: lesson.description,
      teacher: {
        id: lesson.teacher.id,
        name: lesson.teacher.name,
        profile_picture_url: lesson.teacher.profile_picture_url,
      },
      subject: {
        id: lesson.subject.id,
        name: lesson.subject.name,
        grade_level: lesson.subject.grade_level,
      },
      thumbnail: lesson.thumbnail,
      thumbnail_url: this.media.resolveThumbnailUrl(lesson.thumbnail),
      video_url: lesson.video_url,
      video_platform: lesson.video_platform,
      bunny_video_id: lesson.bunny_video_id,
      bunny_library_id: lesson.bunny_library_id,
      bunny_video_status: lesson.bunny_video_status,
      video_width: lesson.video_width,
      video_height: lesson.video_height,
      video_thumbnail: lesson.video_thumbnail,
      video_size_bytes: lesson.video_size_bytes == null ? null : Number(lesson.video_size_bytes),
      price: lesson.price,
      duration: lesson.duration,
      is_group: lesson.is_group,
      available_for_days: lesson.available_for_days,
      students_count: lesson.students_count,
      status: lesson.status,
      created_at: lesson.created_at,
      updated_at: lesson.updated_at,
    };
  }
}
