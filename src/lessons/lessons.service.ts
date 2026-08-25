import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DataSource, LessThanOrEqual, Repository, SelectQueryBuilder } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { LearningMetricsService, ProductFinancialMetricsService } from '../common/metrics';
import { FEATURE_FLAGS, isFeatureEnabled } from '../config/feature-flags';
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
import { ItemType } from '../payments/entities/item-type.enum';
import { fromMinorUnits } from '../payments/money.util';
import { ReviewsService } from '../reviews/reviews.service';
import { Subject } from '../subjects/entities/subject.entity';
import { usableSubjectByIdWhere } from '../subjects/subject-visibility.util';
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
import { LessonVideoUploadSession } from './entities/lesson-video-upload-session.entity';
import { LessonSessionsService } from './lesson-sessions.service';

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
  };
  thumbnail: string | null;
  /** Public URL for `thumbnail`, always routed through the media proxy — never a raw storage URL. */
  thumbnail_url: string | null;
  has_video: boolean;
  bunny_video_status: string | null;
  video_width: number | null;
  video_height: number | null;
  /** Bunny-generated poster, exposed only to the owning teacher detail response. */
  video_thumbnail?: string | null;
  video_size_bytes: number | null;
  price: number;
  duration: number | null;
  is_group: boolean;
  is_free_preview?: boolean;
  available_for_days: number;
  students_count: number;
  /**
   * Count of this Individual Lesson's appointment slots a public buyer could
   * book right now (see `AVAILABLE_SESSION_PREDICATE_SQL`). Always `0` for
   * group lessons, which have no appointment slots.
   */
  available_sessions_count: number;
  /** Earliest such slot's start time, or `null` if none is currently bookable. */
  next_session_at: Date | null;
  status: LessonStatus;
  created_at: Date;
  updated_at: Date;
}
/**
 * Statistics for one lesson, as returned by `GET /admin/lessons/:id/stats`.
 *
 * Every field is derived from a canonical source (DEF-007) — there is no
 * estimate here. Money is in **major units** (EGP), matching `lesson.price`,
 * and `currency` says which currency that is.
 */
export interface LessonStats {
  /**
   * Settled *direct* purchases of this lesson: orders with `item_type` of
   * `lesson` or `lesson_session` that reached a paid state behind a finalised
   * payment. Buying the lesson inside a course is **not** counted here — that
   * sale belongs to the course.
   */
  purchaseCount: number;
  /** Unique students behind `purchaseCount`; a repeat buyer counts once. */
  uniqueStudentCount: number;
  /**
   * Unique students who can actually open the lesson, from direct sales *and*
   * from courses that contain it. This is the "how many students have this
   * lesson" number, and it is normally larger than `uniqueStudentCount`.
   */
  studentsWithAccessCount: number;
  /** Students who have marked the lesson complete in `lesson_progress`. */
  completedCount: number;
  /**
   * **Net** revenue from direct sales: what students were charged after
   * discounts, minus everything refunded. This is the figure to label simply
   * "revenue"; `grossRevenue` and `refundedAmount` break it down.
   */
  totalRevenue: number;
  /** Charged after discount, before refunds. */
  grossRevenue: number;
  /** Discount granted at checkout across settled direct orders. */
  discountAmount: number;
  /** Cumulative refunds against settled direct orders. */
  refundedAmount: number;
  /** Teacher entitlement after proportional refund reversal. */
  teacherEarnings: number;
  /** Platform commission after proportional refund reversal. */
  platformCommission: number;
  /** Currency of every monetary field above. */
  currency: string;
  /** True when this lesson has settled orders in more than one currency. */
  mixedCurrency: boolean;
  /**
   * Mean approved review rating, 2 dp. **`null` means "not yet rated"** — it is
   * deliberately not `0`, which would read as one star.
   */
  averageRating: number | null;
  /** Approved reviews backing `averageRating`. */
  reviewCount: number;
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
  thumbnail: string | null;
  bunny_video_id: string | null;
  bunny_video_status: string | null;
  video_width: number | null;
  video_height: number | null;
  video_size_bytes: string | number | null;
  price: string | number;
  duration: number | null;
  is_group: boolean;
  available_for_days: number;
  /** `COUNT()` from the live subquery — pg returns bigint aggregates as strings. */
  students_count: string | number;
  /** `COUNT()` from `AVAILABLE_SESSIONS_COUNT_SQL` — pg returns bigint aggregates as strings. */
  available_sessions_count: string | number;
  next_session_at: Date | string | null;
  status: LessonStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Live student count for a lesson, as a correlated subquery.
 *
 * Replaces reads of the denormalised `lessons.students_count`, which is
 * rendered as "Students" in the admin, teacher and public surfaces but does not
 * mean that (DEF-007):
 *
 * - It counts **orders**, not students. `PaymentFinalizationService` increments
 *   it once per settled purchase, so a student who re-buys after expiry is
 *   counted twice.
 * - `RefundsService.revokeAccess` decrements it only on a *full* refund, and
 *   nothing reconciles the two, so any missed decrement is permanent — it can
 *   even go negative if a refund lands on a purchase made before the counter
 *   existed.
 * - The column was added by `1820000004000-FixLessonsColumns` with `DEFAULT 0`
 *   and no backfill, so every purchase predating that migration is missing.
 *
 * Counting `lesson_purchases` instead is drift-proof by construction, gives the
 * unique-student meaning the UI implies, covers direct sales and course-bundled
 * access alike, and stays usable as a SQL sort key. Requires
 * `IDX_lesson_purchases_lesson_student_live`.
 */
const LESSON_STUDENT_COUNT_SQL = `(
  SELECT COUNT(DISTINCT lp.student_id)
    FROM lesson_purchases lp
   WHERE lp.lesson_id = lesson.id AND lp.revoked_at IS NULL
)`;

/**
 * WHERE-clause fragment identifying an appointment slot for an Individual
 * Lesson that a public buyer could book right now. Mirrors, field for field,
 * the bookability predicate in `LessonSessionsService.listPublic`: scheduled,
 * starting after the shared booking cutoff, carrying a meeting link, and with
 * no active (held/payment_review/confirmed) booking. Correlated on
 * `session.lesson_id = lesson.id`; requires `:availableSessionsCutoff` to be
 * bound on any query builder that references it. Group lessons have no
 * session rows, so every query built from this fragment is naturally
 * zero/false for them — no `is_group` check is needed here.
 */
const AVAILABLE_SESSION_PREDICATE_SQL = `
  session.lesson_id = lesson.id
  AND session.status = 'scheduled'
  AND session.start_at > :availableSessionsCutoff
  AND session.meeting_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lesson_session_bookings booking
     WHERE booking.scheduled_session_id = session.id
       AND (
         booking.status IN ('payment_review', 'confirmed')
         OR (booking.status = 'held' AND booking.hold_expires_at > NOW())
       )
  )
`;

const AVAILABLE_SESSIONS_COUNT_SQL = `(
  SELECT COUNT(*) FROM scheduled_lesson_sessions session WHERE ${AVAILABLE_SESSION_PREDICATE_SQL}
)`;

const NEXT_SESSION_AT_SQL = `(
  SELECT MIN(session.start_at) FROM scheduled_lesson_sessions session WHERE ${AVAILABLE_SESSION_PREDICATE_SQL}
)`;

const HAS_AVAILABLE_SESSIONS_EXISTS_SQL = `EXISTS (
  SELECT 1 FROM scheduled_lesson_sessions session WHERE ${AVAILABLE_SESSION_PREDICATE_SQL}
)`;

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
    @InjectRepository(LessonVideoUploadSession)
    private readonly uploadSessionsRepository: Repository<LessonVideoUploadSession>,
    private readonly bunnyStream: BunnyStreamService,
    private readonly paymentsService: PaymentsService,
    private readonly media: MediaService,
    private readonly lessonSessions: LessonSessionsService,
    private readonly dataSource: DataSource,
    private readonly productFinancialMetrics: ProductFinancialMetricsService,
    private readonly learningMetrics: LearningMetricsService,
    private readonly reviewsService: ReviewsService,
  ) {}

  /**
   * Create a new lesson
   * Only teachers can create lessons
   */
  public async create(teacherId: string, dto: CreateLessonDto): Promise<LessonWithDetails> {
    if (dto.is_group === true && dto.session_slots?.length) {
      throw new BadRequestException(
        biBody('Group lessons cannot have appointments', 'لا يمكن إضافة مواعيد للدروس الجماعية'),
      );
    }
    if (dto.is_group !== true && (!dto.duration || dto.duration <= 0)) {
      throw new BadRequestException(
        biBody('Individual lessons require a session duration', 'الدروس الفردية تتطلب مدة للجلسة'),
      );
    }
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

    // Validate the subject exists and this teacher may use it (approved
    // catalogue, or their own pending submission)
    const subject = await this.subjectsRepository.findOne({
      where: usableSubjectByIdWhere(dto.subject_id, teacherId),
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
      thumbnail:
        dto.thumbnail === undefined
          ? null
          : this.media.normalizeStoredPublicReference(dto.thumbnail),
      price: dto.price,
      duration: dto.duration ?? null,
      status: LessonStatus.DRAFT,
      is_group: dto.is_group ?? false,
      is_free_preview: dto.is_free_preview ?? false,
      available_for_days: dto.available_for_days ?? 7,
      students_count: 0,
    });

    const savedLesson = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(Lesson, lesson);
      if (!saved.is_group && dto.session_slots?.length) {
        await this.lessonSessions.createManyWithManager(manager, saved, teacherId, dto.session_slots);
      }
      return saved;
    });

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

    return await this.mapToLessonWithDetails(fullLesson);
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
    // Same booking-cutoff horizon `LessonSessionsService.listPublic` uses, so
    // "available" means identically the same thing here as it does on the
    // lesson's own appointment list.
    const availableSessionsCutoff = new Date(
      Date.now() + this.lessonSessions.getBookingCutoffMinutes() * 60_000,
    );

    const baseQuery = this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.deleted_at IS NULL');

    if (publishedOnly) {
      baseQuery.andWhere('lesson.status = :publicStatus', {
        publicStatus: LessonStatus.PUBLISHED,
      });
    }

    this.applyAllFilters(baseQuery, filter, availableSessionsCutoff);

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
      .addSelect('lesson.thumbnail', 'thumbnail')
      .addSelect('lesson.bunny_video_id', 'bunny_video_id')
      .addSelect('lesson.bunny_video_status', 'bunny_video_status')
      .addSelect('lesson.video_width', 'video_width')
      .addSelect('lesson.video_height', 'video_height')
      .addSelect('lesson.video_size_bytes', 'video_size_bytes')
      .addSelect('lesson.price', 'price')
      .addSelect('lesson.duration', 'duration')
      .addSelect('lesson.is_group', 'is_group')
      .addSelect('lesson.available_for_days', 'available_for_days')
      .addSelect(LESSON_STUDENT_COUNT_SQL, 'students_count')
      .addSelect(AVAILABLE_SESSIONS_COUNT_SQL, 'available_sessions_count')
      .addSelect(NEXT_SESSION_AT_SQL, 'next_session_at')
      .addSelect('lesson.status', 'status')
      .addSelect('lesson.created_at', 'created_at')
      .addSelect('lesson.updated_at', 'updated_at')
      .where(`lesson.id IN (${pageIdsQuery.getQuery()})`)
      .setParameters(pageIdsQuery.getParameters())
      .setParameter('availableSessionsCutoff', availableSessionsCutoff);
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
  private applyAllFilters(
    queryBuilder: SelectQueryBuilder<Lesson>,
    filter: LessonFilterDto,
    availableSessionsCutoff: Date,
  ): void {
    const {
      search,
      teacher_id: teacherId,
      subject_id: subjectId,
      is_group: isGroup,
      has_available_sessions: hasAvailableSessions,
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

    if (hasAvailableSessions === true) {
      queryBuilder.andWhere(HAS_AVAILABLE_SESSIONS_EXISTS_SQL, { availableSessionsCutoff });
    } else if (hasAvailableSessions === false) {
      queryBuilder.andWhere(`NOT ${HAS_AVAILABLE_SESSIONS_EXISTS_SQL}`, { availableSessionsCutoff });
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
            ? // Sorting has to happen in SQL over the whole filtered set, so it
              // uses the same live subquery the projection does rather than the
              // dead denormalised column.
              LESSON_STUDENT_COUNT_SQL
            : 'lesson.created_at';

    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    queryBuilder.orderBy(sortColumn, sortOrder).addOrderBy('lesson.id', sortOrder);
  }

  private mapListRowToLessonWithDetails(row: LessonListRawRow): LessonWithDetails {
    const thumbnail = this.media.canonicalPublicReference(row.thumbnail);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      teacher: {
        id: row.teacher_id,
        name: row.teacher_name,
        profile_picture_url: this.media.resolveThumbnailUrl(row.teacher_profile_picture_url),
      },
      subject: {
        id: row.subject_id,
        name: row.subject_name,
      },
      thumbnail,
      thumbnail_url: this.media.resolveThumbnailUrl(thumbnail),
      has_video: row.bunny_video_id !== null,
      bunny_video_status: row.bunny_video_status,
      video_width: row.video_width,
      video_height: row.video_height,
      video_size_bytes: row.video_size_bytes === null ? null : Number(row.video_size_bytes),
      price: Number(row.price),
      duration: row.duration,
      is_group: row.is_group,
      available_for_days: row.available_for_days,
      // COUNT() arrives as a string on the raw-row path.
      students_count: Number(row.students_count),
      available_sessions_count: Number(row.available_sessions_count),
      next_session_at:
        row.next_session_at === null
          ? null
          : row.next_session_at instanceof Date
            ? row.next_session_at
            : new Date(row.next_session_at),
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

    return await this.mapToLessonWithDetails(lesson);
  }

  public async findOnePublic(id: string): Promise<PublicLessonResponseDto> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id, status: LessonStatus.PUBLISHED },
      relations: ['teacher', 'subject'],
    });

    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'Lesson not found'));
    }

    return toPublicLessonResponse(await this.mapToLessonWithDetails(lesson), (value) =>
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
    await this.validateSubjectChange(dto, lesson, teacherId);

    if (dto.is_group !== undefined && dto.is_group !== lesson.is_group) {
      const dependencies = (await this.dataSource.query(
        `SELECT
           EXISTS (SELECT 1 FROM lesson_purchases WHERE lesson_id = $1) OR
           EXISTS (SELECT 1 FROM orders WHERE item_type = 'lesson' AND item_id = $1) OR
           EXISTS (SELECT 1 FROM lesson_package_items WHERE lesson_id = $1) OR
           EXISTS (SELECT 1 FROM scheduled_lesson_sessions WHERE lesson_id = $1)
           AS blocked`,
        [lessonId],
      )) as Array<{ blocked: boolean }>;
      if (dependencies[0]?.blocked) {
        throw new ConflictException(
          biBody(
            'Lesson type cannot change after purchases, package inclusion, or appointments exist',
            'Lesson type cannot change after it has dependencies',
          ),
        );
      }
    }
    const resultingIndividual = dto.is_group === false || (dto.is_group === undefined && !lesson.is_group);
    const resultingDuration = dto.duration ?? lesson.duration;
    if (resultingIndividual && (!resultingDuration || resultingDuration <= 0)) {
      throw new BadRequestException(
        biBody('Individual lessons require a session duration', 'تتطلب الدروس الفردية مدة للجلسة'),
      );
    }

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

    return await this.mapToLessonWithDetails(fullLesson);
  }

  /**
   * Only validates when the subject is actually changing. That matters now
   * that subjects can be suspended: re-checking an unchanged `subject_id`
   * would make every lesson on a suspended subject uneditable.
   */
  private async validateSubjectChange(
    dto: UpdateLessonDto,
    lesson: Lesson,
    teacherId: string,
  ): Promise<void> {
    if (dto.subject_id !== undefined && dto.subject_id !== lesson.subject_id) {
      const subject = await this.subjectsRepository.findOne({
        where: usableSubjectByIdWhere(dto.subject_id, teacherId),
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
      updates.thumbnail = this.media.normalizeStoredPublicReference(dto.thumbnail);
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
    Object.assign(lesson, updates);
  }

  /** Publishing is deliberately separate from metadata editing. */
  public async publishLesson(lessonId: string, teacherId: string): Promise<LessonWithDetails> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId, ['teacher', 'subject']);
    await this.assertPublishable(lesson);
    if (lesson.status !== LessonStatus.PUBLISHED) {
      lesson.status = LessonStatus.PUBLISHED;
      await this.lessonsRepository.save(lesson);
    }
    return await this.mapToLessonWithDetails(lesson);
  }

  /** Teachers may hide or return a lesson to draft, but never publish here. */
  public async setLessonVisibility(
    lessonId: string,
    teacherId: string,
    visibility: LessonStatus.DRAFT | LessonStatus.HIDDEN,
  ): Promise<LessonWithDetails> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId, ['teacher', 'subject']);
    lesson.status = visibility;
    await this.lessonsRepository.save(lesson);
    return await this.mapToLessonWithDetails(lesson);
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

    await this.assertNoScheduledSessionHistory(lessonId);

    // Database state is authoritative: never delete external media before the
    // soft-delete succeeds, otherwise a failed write leaves a visible lesson
    // without its video.
    await this.lessonsRepository.softDelete(lessonId);
    if (lesson.bunny_video_id) {
      await this.bunnyStream.deleteVideo(lesson.bunny_video_id);
    }
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

    await this.assertNoScheduledSessionHistory(lessonId);
    await this.lessonsRepository.softDelete(lessonId);
  }

  private async assertNoScheduledSessionHistory(lessonId: string): Promise<void> {
    const rows = await this.dataSource.query<Array<{ exists: boolean }>>(
      'SELECT EXISTS (SELECT 1 FROM scheduled_lesson_sessions WHERE lesson_id = $1) AS "exists"',
      [lessonId],
    );
    if (rows[0]?.exists) {
      throw new ConflictException(
        biBody(
          'Lessons with appointment history cannot be deleted; cancel future appointments instead',
          'لا يمكن حذف درس يحتوي على سجل مواعيد؛ ألغِ المواعيد المستقبلية بدلاً من ذلك',
        ),
      );
    }
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
   * Statistics for one lesson, from the canonical sources only.
   *
   * Each group of fields comes from the one service that owns that definition,
   * so this method contains no business arithmetic of its own:
   *
   * | Fields                    | Source                                            |
   * |---------------------------|---------------------------------------------------|
   * | money, purchase counts    | `ProductFinancialMetricsService` (settled `orders`) |
   * | access / completion       | `LearningMetricsService` (`lesson_purchases`, `lesson_progress`) |
   * | rating                    | `ReviewsService` (approved `lesson_reviews`)      |
   *
   * The previous implementation estimated revenue as `lesson.price ×
   * students_count` and hardcoded the rating to `0` (DEF-007). That estimate
   * silently ignored discounts, refunds and commission, charged the *current*
   * catalogue price against historical sales, and counted course-bundled
   * grants — which pay nothing towards this lesson — as full-price purchases.
   */
  public async getLessonStats(lessonId: string): Promise<LessonStats> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
      select: { id: true },
    });

    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }

    const [financial, engagement, rating] = await Promise.all([
      // A lesson sells as an outright purchase or as a bookable session; both
      // are direct sales of this lesson, matching the pairing ReportsService
      // uses for its "lessons" revenue bucket.
      this.productFinancialMetrics.getProductFinancialMetricsForTypes(
        [ItemType.LESSON, ItemType.LESSON_SESSION],
        lessonId,
      ),
      this.learningMetrics.getLessonEngagementMetrics(lessonId),
      this.reviewsService.getLessonAggregates(lessonId),
    ]);

    const money = financial.primary;
    return {
      purchaseCount: money.order_count,
      uniqueStudentCount: money.unique_student_count,
      studentsWithAccessCount: engagement.students_with_access,
      completedCount: engagement.students_completed,
      totalRevenue: fromMinorUnits(money.net_revenue_minor),
      grossRevenue: fromMinorUnits(money.gross_sales_minor),
      discountAmount: fromMinorUnits(money.discount_amount_minor),
      refundedAmount: fromMinorUnits(money.refund_amount_minor),
      teacherEarnings: fromMinorUnits(money.teacher_earnings_minor),
      platformCommission: fromMinorUnits(money.platform_commission_minor),
      currency: money.currency,
      mixedCurrency: financial.mixed_currency,
      // ReviewsService reports 0 for "no reviews"; the API contract here is an
      // explicit null so the UI shows "not rated" rather than one star.
      averageRating: rating.total_reviews === 0 ? null : rating.average_rating,
      reviewCount: rating.total_reviews,
    };
  }

  /* ============================================================
   * Bunny Stream — secure direct (TUS) upload orchestration
   * ============================================================ */

  private async findOwnedLesson(
    lessonId: string,
    teacherId: string,
    relations?: Array<'teacher' | 'subject'>,
  ): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
      ...(relations !== undefined ? { relations } : {}),
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

  /** Create a short-lived, server-authorized direct TUS upload session. */
  public async createBunnyUploadSession(
    lessonId: string,
    teacherId: string,
    title?: string,
  ): Promise<{
    sessionId: string;
    endpoint: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }> {
    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    const created = await this.bunnyStream.createVideo(title ?? lesson.title);
    let authorization;
    try {
      authorization = this.bunnyStream.createTusAuthorization(created.videoId, 60 * 60);
      const session = this.uploadSessionsRepository.create({
        lesson_id: lesson.id,
        teacher_id: teacherId,
        bunny_video_id: created.videoId,
        previous_bunny_video_id: lesson.bunny_video_id,
        status: 'created',
        expires_at: authorization.expiresAt,
        completed_at: null,
        cleaned_at: null,
        cleanup_attempts: 0,
        last_cleanup_error: null,
      });
      const saved = await this.uploadSessionsRepository.save(session);
      return {
        sessionId: saved.id,
        endpoint: authorization.endpoint,
        headers: authorization.headers,
        expiresAt: authorization.expiresAt,
      };
    } catch (error) {
      // The session was never committed, so the created provider asset is an
      // orphan. Cleanup is safe and must not mask the original failure.
      await this.bunnyStream.deleteVideo(created.videoId);
      throw error;
    }
  }

  /** Atomically attach an uploaded Bunny asset only after Bunny confirms it exists. */
  public async completeBunnyUploadSession(
    lessonId: string,
    teacherId: string,
    sessionId: string,
  ): Promise<{ status: string }> {
    const session = await this.uploadSessionsRepository.findOne({
      where: { id: sessionId, lesson_id: lessonId, teacher_id: teacherId },
    });
    if (!session) {
      throw new NotFoundException(biBody('Upload session not found.', 'جلسة الرفع غير موجودة.'));
    }
    if (session.status === 'completed') return { status: 'processing' };
    if (session.expires_at <= new Date()) {
      throw new ConflictException(
        biBody(
          'Upload session has expired. Start a new upload.',
          'انتهت صلاحية جلسة الرفع. ابدأ رفعاً جديداً.',
        ),
      );
    }

    const lesson = await this.findOwnedLesson(lessonId, teacherId);
    const meta = await this.bunnyStream.getVideo(session.bunny_video_id);
    if (meta.status === 'created') {
      throw new ConflictException(
        biBody('Upload has not finished yet.', 'لم يكتمل رفع الفيديو بعد.'),
      );
    }

    lesson.video_platform = 'bunny';
    lesson.bunny_video_id = session.bunny_video_id;
    lesson.bunny_video_status = meta.status;
    lesson.video_url = null;
    lesson.video_thumbnail = null;
    lesson.video_width = meta.width;
    lesson.video_height = meta.height;
    lesson.video_size_bytes = meta.sizeBytes;
    if (meta.durationSeconds !== null) lesson.duration = meta.durationSeconds;
    await this.lessonsRepository.save(lesson);

    session.status = session.previous_bunny_video_id ? 'cleanup_pending' : 'completed';
    session.completed_at = new Date();
    await this.uploadSessionsRepository.save(session);
    await this.cleanupUploadSession(session);
    return { status: meta.status };
  }

  /** Durable cleanup saga for expired uploads and replacement leftovers. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  public async cleanExpiredBunnyUploadSessions(): Promise<void> {
    // DESTRUCTIVE: `cleanupUploadSession` deletes the abandoned video from the
    // configured Bunny Stream library. Gated by the same flag as the weekly
    // orphan sweep; default-on, so production is unchanged.
    if (!isFeatureEnabled(FEATURE_FLAGS.FILE_CLEANUP)) {
      this.logger.log('Expired upload-session cleanup skipped: ENABLE_FILE_CLEANUP=false.');
      return;
    }

    const sessions = await this.uploadSessionsRepository.find({
      where: [
        { status: 'created', expires_at: LessThanOrEqual(new Date()) },
        { status: 'cleanup_pending' },
      ],
      take: 100,
      order: { created_at: 'ASC' },
    });
    for (const session of sessions) {
      if (session.status === 'created') session.status = 'abandoned';
      await this.cleanupUploadSession(session);
    }
  }

  private async cleanupUploadSession(session: LessonVideoUploadSession): Promise<void> {
    const videoId =
      session.status === 'abandoned' ? session.bunny_video_id : session.previous_bunny_video_id;
    if (!videoId) return;
    try {
      const deleted = await this.bunnyStream.deleteVideo(videoId);
      if (!deleted) throw new Error('Bunny cleanup did not complete');
      session.status = 'cleaned';
      session.cleaned_at = new Date();
      session.last_cleanup_error = null;
    } catch (error) {
      session.status = 'cleanup_pending';
      session.cleanup_attempts += 1;
      session.last_cleanup_error =
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error';
    }
    await this.uploadSessionsRepository.save(session);
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
      this.logger.log(
        `Lesson ${lessonId}: replacement live, queuing cleanup of ${previousVideoId}`,
      );
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
  ): Promise<
    Pick<
      BunnyVideoMetadata,
      'status' | 'progress' | 'durationSeconds' | 'width' | 'height' | 'sizeBytes'
    > & { lessonId: string }
  > {
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
    if (meta.durationSeconds != null) lesson.duration = meta.durationSeconds;
    if (meta.width != null) lesson.video_width = meta.width;
    if (meta.height != null) lesson.video_height = meta.height;
    if (meta.thumbnailUrl != null) lesson.video_thumbnail = meta.thumbnailUrl;
    if (meta.sizeBytes != null) lesson.video_size_bytes = meta.sizeBytes;
    await this.lessonsRepository.save(lesson);

    return {
      lessonId: lesson.id,
      status: meta.status,
      progress: meta.progress,
      durationSeconds: meta.durationSeconds,
      width: meta.width,
      height: meta.height,
      sizeBytes: meta.sizeBytes,
    };
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
    // Students must never play a draft/hidden lesson even if an old purchase
    // exists. Owners/admins retain editorial access to unpublished content.
    if (!isOwner && !isAdmin && lesson.status !== LessonStatus.PUBLISHED) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }
    const isFreePreview = lesson.is_free_preview && lesson.bunny_video_status === 'ready';
    const hasAccess =
      isOwner ||
      isAdmin ||
      isFreePreview ||
      (await this.paymentsService.hasLessonPlaybackAccess(userId, lessonId));

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
  ): Promise<{ signedUrl: string; expiresIn: number }> {
    const lesson = await this.assertViewerAccess(lessonId, userId, role);
    if (!lesson.bunny_video_id || lesson.bunny_video_status !== 'ready') {
      throw new BadRequestException(
        biBody('This lesson has no ready video.', 'لا يوجد لهذا الدرس فيديو جاهز.'),
      );
    }

    const ttlSeconds = 5 * 60;
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
   * encoding (lessons with no Bunny video are unaffected), and — for an
   * Individual Lesson — once it has at least one future appointment with a
   * ready meeting (Phase 5.3). Placed here rather than at session-creation
   * time so a teacher can create appointments, connect a provider and
   * Generate at their own pace before publishing.
   */
  public async assertPublishable(lesson: Lesson): Promise<void> {
    if (lesson.title.trim().length === 0) {
      throw new BadRequestException(
        biBody('A lesson title is required before publishing.', 'يلزم عنوان للدرس قبل النشر.'),
      );
    }
    if (lesson.bunny_video_id && lesson.bunny_video_status !== 'ready') {
      throw new BadRequestException(
        biBody(
          'Video is still processing. You can publish once it is ready.',
          'الفيديو ما زال قيد المعالجة. يمكنك النشر بمجرد أن يصبح جاهزًا.',
        ),
      );
    }
    if (!lesson.is_group) {
      const { count } = await this.getAvailableSessionsSummary(lesson.id);
      if (count === 0) {
        throw new BadRequestException(
          biBody(
            'Add an appointment with a ready meeting before publishing',
            'أضف موعدًا باجتماع جاهز قبل النشر',
          ),
        );
      }
    }
  }

  /**
   * Helper method to map Lesson entity to response type
   */
  /**
   * Single-lesson counterpart to `AVAILABLE_SESSIONS_COUNT_SQL` /
   * `NEXT_SESSION_AT_SQL` — reuses the identical correlated subqueries,
   * scoped to one lesson via `WHERE lesson.id = :lessonId`, so `findOne`,
   * `findOnePublic` and every mutation that reloads a lesson stay in lockstep
   * with the list endpoint's "available appointments" figure.
   */
  private async getAvailableSessionsSummary(
    lessonId: string,
  ): Promise<{ count: number; nextAt: Date | null }> {
    const availableSessionsCutoff = new Date(
      Date.now() + this.lessonSessions.getBookingCutoffMinutes() * 60_000,
    );
    const row = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .select(AVAILABLE_SESSIONS_COUNT_SQL, 'count')
      .addSelect(NEXT_SESSION_AT_SQL, 'next_at')
      .where('lesson.id = :lessonId', { lessonId })
      .setParameter('availableSessionsCutoff', availableSessionsCutoff)
      .getRawOne<{ count: string; next_at: Date | string | null }>();
    return {
      count: Number(row?.count ?? 0),
      nextAt: row?.next_at
        ? row.next_at instanceof Date
          ? row.next_at
          : new Date(row.next_at)
        : null,
    };
  }

  private async mapToLessonWithDetails(lesson: Lesson): Promise<LessonWithDetails> {
    const thumbnail = this.media.canonicalPublicReference(lesson.thumbnail);
    // Live count from lesson_purchases; the denormalised `lesson.students_count`
    // counts orders and can drift (see LESSON_STUDENT_COUNT_SQL) and is not read.
    const [studentCounts, availableSessions] = await Promise.all([
      this.learningMetrics.getLessonStudentCounts([lesson.id]),
      this.getAvailableSessionsSummary(lesson.id),
    ]);
    return {
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      teacher: {
        id: lesson.teacher.id,
        name: lesson.teacher.name,
        profile_picture_url: this.media.resolveThumbnailUrl(lesson.teacher.profile_picture_url),
      },
      subject: {
        id: lesson.subject.id,
        name: lesson.subject.name,
      },
      thumbnail,
      thumbnail_url: this.media.resolveThumbnailUrl(thumbnail),
      has_video: lesson.bunny_video_id !== null,
      bunny_video_status: lesson.bunny_video_status,
      video_width: lesson.video_width,
      video_height: lesson.video_height,
      video_thumbnail: lesson.video_thumbnail,
      video_size_bytes: lesson.video_size_bytes == null ? null : Number(lesson.video_size_bytes),
      price: lesson.price,
      duration: lesson.duration,
      is_group: lesson.is_group,
      is_free_preview: lesson.is_free_preview,
      available_for_days: lesson.available_for_days,
      students_count: studentCounts.get(lesson.id) ?? 0,
      available_sessions_count: availableSessions.count,
      next_session_at: availableSessions.nextAt,
      status: lesson.status,
      created_at: lesson.created_at,
      updated_at: lesson.updated_at,
    };
  }
}
