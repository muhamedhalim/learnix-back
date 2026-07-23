import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { CreateReviewDto, UpdateReviewDto } from './dto';
import { ReviewHelpfulVote, ReviewTargetType } from './entities/review-helpful-vote.entity';
import { ReviewStatus } from './entities/review-status.enum';
import { LessonReview } from './entities/lesson-review.entity';
import { TeacherReview } from './entities/teacher-review.entity';
import {
  ReviewAggregates,
  ReviewForManagement,
  ReviewWithStudent,
} from './interfaces/review-aggregates.interface';

interface RatingAggregateRow {
  total: string;
  average: string;
  rating_1: string;
  rating_2: string;
  rating_3: string;
  rating_4: string;
  rating_5: string;
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(TeacherReview)
    private readonly teacherReviewsRepository: Repository<TeacherReview>,
    @InjectRepository(LessonReview)
    private readonly lessonReviewsRepository: Repository<LessonReview>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchasesRepository: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    @InjectRepository(LessonProgress)
    private readonly lessonProgressRepository: Repository<LessonProgress>,
    @InjectRepository(ReviewHelpfulVote)
    private readonly helpfulVotesRepository: Repository<ReviewHelpfulVote>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
  ) {}

  /* ===================== Eligibility checks ===================== */

  /** Student has purchased ANY lesson from a teacher (direct or via package). */
  private async validateStudentHasPurchasedFromTeacher(
    studentId: string,
    teacherId: string,
  ): Promise<boolean> {
    const directPurchase = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lessons', 'l', 'l.id = lp.lesson_id')
      .where('lp.student_id = :studentId', { studentId })
      .andWhere('lp.revoked_at IS NULL')
      .andWhere('l.teacher_id = :teacherId', { teacherId })
      .getOne();

    if (directPurchase) {
      return true;
    }

    const packagePurchase = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('lesson_packages', 'pkg', 'pkg.id = pp.package_id')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.package_id = pkg.id')
      .innerJoin('lessons', 'l', 'l.id = lpi.lesson_id')
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('pp.revoked_at IS NULL')
      .andWhere('l.teacher_id = :teacherId', { teacherId })
      .getOne();

    return !!packagePurchase;
  }

  /** Student has purchased a specific lesson (direct or via a package). */
  private async validateStudentHasPurchasedLesson(
    studentId: string,
    lessonId: string,
  ): Promise<boolean> {
    const directPurchase = await this.lessonPurchasesRepository.findOne({
      where: { student_id: studentId, lesson_id: lessonId, revoked_at: IsNull() },
    });

    if (directPurchase) {
      return true;
    }

    const packagePurchase = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('lesson_packages', 'lp', 'lp.id = pp.package_id')
      .innerJoin(
        'lesson_package_items',
        'lpi',
        'lpi.package_id = lp.id AND lpi.lesson_id = :lessonId',
        { lessonId },
      )
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('pp.revoked_at IS NULL')
      .getOne();

    return !!packagePurchase;
  }

  /** Student has completed a lesson (progress row flagged completed). */
  private async validateStudentCompletedLesson(
    studentId: string,
    lessonId: string,
  ): Promise<boolean> {
    const progress = await this.lessonProgressRepository.findOne({
      where: { student_id: studentId, lesson_id: lessonId, completed: true },
      select: { id: true },
    });
    return !!progress;
  }

  /* ===================== Create ===================== */

  public async createTeacherReview(
    teacherId: string,
    studentId: string,
    dto: CreateReviewDto,
  ): Promise<TeacherReview> {
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId, role: UserRole.TEACHER },
    });
    if (!teacher) {
      throw new NotFoundException(biBody('Teacher not found', 'المعلم غير موجود'));
    }

    const hasPurchase = await this.validateStudentHasPurchasedFromTeacher(studentId, teacherId);
    if (!hasPurchase) {
      throw new ForbiddenException(
        biBody(
          'You must purchase a lesson from this teacher before reviewing',
          'يجب شراء درس من هذا المعلم قبل تقييمه',
        ),
      );
    }

    const existingReview = await this.teacherReviewsRepository.findOne({
      where: { teacher_id: teacherId, student_id: studentId },
    });
    if (existingReview) {
      throw new ConflictException(
        biBody('You have already reviewed this teacher.', 'لقد قمت بتقييم هذا المعلم مسبقًا.'),
      );
    }

    const review = this.teacherReviewsRepository.create({
      teacher_id: teacherId,
      student_id: studentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });

    return this.teacherReviewsRepository.save(review);
  }

  public async createLessonReview(
    lessonId: string,
    studentId: string,
    dto: CreateReviewDto,
  ): Promise<LessonReview> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    const hasPurchase = await this.validateStudentHasPurchasedLesson(studentId, lessonId);
    if (!hasPurchase) {
      throw new ForbiddenException(
        biBody('You must purchase this lesson before reviewing', 'يجب شراء هذا الدرس قبل تقييمه'),
      );
    }

    // Reviews are only allowed after the lesson has been completed.
    const hasCompleted = await this.validateStudentCompletedLesson(studentId, lessonId);
    if (!hasCompleted) {
      throw new ForbiddenException(
        biBody(
          'You can review this lesson only after completing it',
          'يمكنك تقييم هذا الدرس فقط بعد إكماله',
        ),
      );
    }

    const existingReview = await this.lessonReviewsRepository.findOne({
      where: { lesson_id: lessonId, student_id: studentId },
    });
    if (existingReview) {
      throw new ConflictException(
        biBody('You have already reviewed this lesson.', 'لقد قمت بتقييم هذا الدرس مسبقًا.'),
      );
    }

    const review = this.lessonReviewsRepository.create({
      lesson_id: lessonId,
      student_id: studentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });

    return this.lessonReviewsRepository.save(review);
  }

  /* ===================== Update / Delete (student, own) ===================== */

  public async updateLessonReview(
    lessonId: string,
    studentId: string,
    dto: UpdateReviewDto,
  ): Promise<LessonReview> {
    const review = await this.lessonReviewsRepository.findOne({
      where: { lesson_id: lessonId, student_id: studentId },
    });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    this.applyReviewUpdate(review, dto);
    return this.lessonReviewsRepository.save(review);
  }

  public async deleteLessonReview(lessonId: string, studentId: string): Promise<void> {
    const review = await this.lessonReviewsRepository.findOne({
      where: { lesson_id: lessonId, student_id: studentId },
    });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    await this.deleteReviewRow(ReviewTargetType.LESSON, review.id);
    await this.lessonReviewsRepository.remove(review);
  }

  public async updateTeacherReview(
    teacherId: string,
    studentId: string,
    dto: UpdateReviewDto,
  ): Promise<TeacherReview> {
    const review = await this.teacherReviewsRepository.findOne({
      where: { teacher_id: teacherId, student_id: studentId },
    });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    this.applyReviewUpdate(review, dto);
    return this.teacherReviewsRepository.save(review);
  }

  public async deleteTeacherReview(teacherId: string, studentId: string): Promise<void> {
    const review = await this.teacherReviewsRepository.findOne({
      where: { teacher_id: teacherId, student_id: studentId },
    });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    await this.deleteReviewRow(ReviewTargetType.TEACHER, review.id);
    await this.teacherReviewsRepository.remove(review);
  }

  private applyReviewUpdate(review: LessonReview | TeacherReview, dto: UpdateReviewDto): void {
    if (dto.rating !== undefined) {
      review.rating = dto.rating;
    }
    if (dto.comment !== undefined) {
      review.comment = dto.comment;
    }
  }

  /* ===================== Teacher reply ===================== */

  /** Reply to a review on one of the teacher's own lessons. */
  public async replyToLessonReview(
    reviewId: string,
    teacherId: string,
    reply: string,
  ): Promise<LessonReview> {
    const review = await this.lessonReviewsRepository.findOne({
      where: { id: reviewId },
      relations: ['lesson'],
    });
    if (!review) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
    if (review.lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody(
          'You can only reply to reviews on your own lessons',
          'يمكنك الرد فقط على التقييمات الخاصة بدروسك',
        ),
      );
    }

    review.teacher_reply = reply;
    review.teacher_reply_at = new Date();
    return this.lessonReviewsRepository.save(review);
  }

  /** Reviews across all of a teacher's lessons (teacher dashboard). */
  public async getTeacherLessonReviews(
    teacherId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<ReviewForManagement>> {
    const qb = this.lessonReviewsRepository
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.lesson', 'lesson')
      .innerJoinAndSelect('r.student', 'student')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [reviews, total] = await qb.getManyAndCount();

    const data: ReviewForManagement[] = reviews.map((r) => ({
      ...this.toReviewWithStudent(r, true),
      status: r.status,
      review_type: 'lesson',
      target_id: r.lesson_id,
      target_title: r.lesson.title,
    }));

    return { data, meta: this.buildMeta(page, limit, total) };
  }

  /* ===================== Helpful votes ===================== */

  /** Toggle the current user's "helpful" vote on a review. */
  public async toggleHelpfulVote(
    type: ReviewTargetType,
    reviewId: string,
    userId: string,
  ): Promise<{ helpful: boolean; helpful_count: number }> {
    await this.assertReviewExists(type, reviewId);

    const existing = await this.helpfulVotesRepository.findOne({
      where: { review_type: type, review_id: reviewId, user_id: userId },
    });

    if (existing) {
      await this.helpfulVotesRepository.remove(existing);
      const count = await this.adjustHelpfulCount(type, reviewId, -1);
      return { helpful: false, helpful_count: count };
    }

    const vote = this.helpfulVotesRepository.create({
      review_type: type,
      review_id: reviewId,
      user_id: userId,
    });
    await this.helpfulVotesRepository.save(vote);
    const count = await this.adjustHelpfulCount(type, reviewId, 1);
    return { helpful: true, helpful_count: count };
  }

  /** IDs of reviews (of a given type) the user has voted helpful — hydration. */
  public async getUserHelpfulVotes(
    type: ReviewTargetType,
    userId: string,
    reviewIds: string[],
  ): Promise<Set<string>> {
    if (reviewIds.length === 0) {
      return new Set();
    }
    const votes = await this.helpfulVotesRepository
      .createQueryBuilder('v')
      .select('v.review_id', 'review_id')
      .where('v.review_type = :type', { type })
      .andWhere('v.user_id = :userId', { userId })
      .andWhere('v.review_id IN (:...ids)', { ids: reviewIds })
      .getRawMany<{ review_id: string }>();
    return new Set(votes.map((v) => v.review_id));
  }

  /* ===================== Admin moderation ===================== */

  public async moderateReview(
    type: ReviewTargetType,
    reviewId: string,
    status: ReviewStatus,
  ): Promise<{ id: string; status: ReviewStatus }> {
    if (type === ReviewTargetType.LESSON) {
      const review = await this.lessonReviewsRepository.findOne({
        where: { id: reviewId },
      });
      if (!review) {
        throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
      }
      review.status = status;
      await this.lessonReviewsRepository.save(review);
    } else {
      const review = await this.teacherReviewsRepository.findOne({
        where: { id: reviewId },
      });
      if (!review) {
        throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
      }
      review.status = status;
      await this.teacherReviewsRepository.save(review);
    }
    return { id: reviewId, status };
  }

  public async adminDeleteReview(type: ReviewTargetType, reviewId: string): Promise<void> {
    if (type === ReviewTargetType.LESSON) {
      const review = await this.lessonReviewsRepository.findOne({
        where: { id: reviewId },
      });
      if (!review) {
        throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
      }
      await this.deleteReviewRow(type, reviewId);
      await this.lessonReviewsRepository.remove(review);
    } else {
      const review = await this.teacherReviewsRepository.findOne({
        where: { id: reviewId },
      });
      if (!review) {
        throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
      }
      await this.deleteReviewRow(type, reviewId);
      await this.teacherReviewsRepository.remove(review);
    }
  }

  /** Lesson reviews for moderation (all statuses, optional status filter). */
  public async getLessonReviewsForModeration(
    page = 1,
    limit = 20,
    status?: ReviewStatus,
  ): Promise<PaginatedResponse<ReviewForManagement>> {
    const qb = this.lessonReviewsRepository
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.lesson', 'lesson')
      .innerJoinAndSelect('r.student', 'student')
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (status) {
      qb.where('r.status = :status', { status });
    }
    const [reviews, total] = await qb.getManyAndCount();
    const data: ReviewForManagement[] = reviews.map((r) => ({
      ...this.toReviewWithStudent(r, true),
      status: r.status,
      review_type: 'lesson',
      target_id: r.lesson_id,
      target_title: r.lesson.title,
    }));
    return { data, meta: this.buildMeta(page, limit, total) };
  }

  /** Teacher reviews for moderation (all statuses, optional status filter). */
  public async getTeacherReviewsForModeration(
    page = 1,
    limit = 20,
    status?: ReviewStatus,
  ): Promise<PaginatedResponse<ReviewForManagement>> {
    const qb = this.teacherReviewsRepository
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.teacher', 'teacher')
      .innerJoinAndSelect('r.student', 'student')
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (status) {
      qb.where('r.status = :status', { status });
    }
    const [reviews, total] = await qb.getManyAndCount();
    const data: ReviewForManagement[] = reviews.map((r) => ({
      ...this.toReviewWithStudent(r, false),
      status: r.status,
      review_type: 'teacher',
      target_id: r.teacher_id,
      target_title: r.teacher.name,
    }));
    return { data, meta: this.buildMeta(page, limit, total) };
  }

  /* ===================== Public reads ===================== */

  public async getTeacherReviews(
    teacherId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<ReviewWithStudent> & { aggregates: ReviewAggregates }> {
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId, role: UserRole.TEACHER },
    });
    if (!teacher) {
      throw new NotFoundException(biBody('Teacher not found', 'المعلم غير موجود'));
    }

    const [reviews, total] = await this.teacherReviewsRepository.findAndCount({
      where: { teacher_id: teacherId, status: ReviewStatus.APPROVED },
      relations: ['student'],
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const aggregates = await this.teacherAggregates(teacherId);

    const data = reviews.map((r) => this.toReviewWithStudent(r, false));
    return { data, meta: this.buildMeta(page, limit, total), aggregates };
  }

  public async getLessonReviews(
    lessonId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<ReviewWithStudent> & { aggregates: ReviewAggregates }> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    const [reviews, total] = await this.lessonReviewsRepository.findAndCount({
      where: { lesson_id: lessonId, status: ReviewStatus.APPROVED },
      relations: ['student'],
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const aggregates = await this.lessonAggregates(lessonId);

    const data = reviews.map((r) => this.toReviewWithStudent(r, true));
    return { data, meta: this.buildMeta(page, limit, total), aggregates };
  }

  /**
   * Rating aggregates for a course (package), derived from the reviews of the
   * lessons it contains — no separate package_reviews table needed.
   */
  public async getPackageAggregates(packageId: string): Promise<ReviewAggregates> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      select: { id: true },
    });
    if (!pkg) {
      throw new NotFoundException(biBody('Package not found', 'الحزمة غير موجودة'));
    }

    const row = await this.lessonReviewsRepository
      .createQueryBuilder('r')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.lesson_id = r.lesson_id')
      .where('lpi.package_id = :packageId', { packageId })
      .andWhere('r.status = :status', { status: ReviewStatus.APPROVED })
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(r.rating), 0)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 1)', 'rating_1')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 2)', 'rating_2')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 3)', 'rating_3')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 4)', 'rating_4')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 5)', 'rating_5')
      .getRawOne<RatingAggregateRow>();

    return this.toRatingAggregates(row);
  }

  /* ===================== Helpers ===================== */

  private toReviewWithStudent(
    review: LessonReview | TeacherReview,
    includeReply: boolean,
  ): ReviewWithStudent {
    const base: ReviewWithStudent = {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      student: {
        id: review.student.id,
        name: review.student.name,
      },
      verified_purchase: true,
      helpful_count: review.helpful_count,
      created_at: review.created_at,
    };
    if (includeReply && 'teacher_reply' in review) {
      base.teacher_reply = review.teacher_reply;
      base.teacher_reply_at = review.teacher_reply_at;
    }
    return base;
  }

  private buildMeta(page: number, limit: number, total: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  private async lessonAggregates(lessonId: string): Promise<ReviewAggregates> {
    const row = await this.lessonReviewsRepository
      .createQueryBuilder('r')
      .where('r.lesson_id = :lessonId', { lessonId })
      .andWhere('r.status = :status', { status: ReviewStatus.APPROVED })
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(r.rating), 0)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 1)', 'rating_1')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 2)', 'rating_2')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 3)', 'rating_3')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 4)', 'rating_4')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 5)', 'rating_5')
      .getRawOne<RatingAggregateRow>();
    return this.toRatingAggregates(row);
  }

  private async teacherAggregates(teacherId: string): Promise<ReviewAggregates> {
    const row = await this.teacherReviewsRepository
      .createQueryBuilder('r')
      .where('r.teacher_id = :teacherId', { teacherId })
      .andWhere('r.status = :status', { status: ReviewStatus.APPROVED })
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(r.rating), 0)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 1)', 'rating_1')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 2)', 'rating_2')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 3)', 'rating_3')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 4)', 'rating_4')
      .addSelect('COUNT(*) FILTER (WHERE r.rating = 5)', 'rating_5')
      .getRawOne<RatingAggregateRow>();
    return this.toRatingAggregates(row);
  }

  private toRatingAggregates(row: RatingAggregateRow | null | undefined): ReviewAggregates {
    return {
      average_rating: Number.parseFloat(Number(row?.average ?? 0).toFixed(2)),
      total_reviews: Number.parseInt(row?.total ?? '0', 10),
      rating_distribution: {
        1: Number.parseInt(row?.rating_1 ?? '0', 10),
        2: Number.parseInt(row?.rating_2 ?? '0', 10),
        3: Number.parseInt(row?.rating_3 ?? '0', 10),
        4: Number.parseInt(row?.rating_4 ?? '0', 10),
        5: Number.parseInt(row?.rating_5 ?? '0', 10),
      },
    };
  }

  private async assertReviewExists(type: ReviewTargetType, reviewId: string): Promise<void> {
    const exists =
      type === ReviewTargetType.LESSON
        ? await this.lessonReviewsRepository.findOne({
            where: { id: reviewId },
            select: { id: true },
          })
        : await this.teacherReviewsRepository.findOne({
            where: { id: reviewId },
            select: { id: true },
          });
    if (!exists) {
      throw new NotFoundException(biBody('Review not found', 'التقييم غير موجود'));
    }
  }

  /** Adjust a review's denormalised helpful_count and return the new value. */
  private async adjustHelpfulCount(
    type: ReviewTargetType,
    reviewId: string,
    delta: 1 | -1,
  ): Promise<number> {
    const expr = `GREATEST(helpful_count + (${delta}), 0)`;
    if (type === ReviewTargetType.LESSON) {
      await this.lessonReviewsRepository
        .createQueryBuilder()
        .update()
        .set({ helpful_count: () => expr })
        .where('id = :id', { id: reviewId })
        .execute();
      const updated = await this.lessonReviewsRepository.findOne({
        where: { id: reviewId },
        select: { id: true, helpful_count: true },
      });
      return updated?.helpful_count ?? 0;
    }
    await this.teacherReviewsRepository
      .createQueryBuilder()
      .update()
      .set({ helpful_count: () => expr })
      .where('id = :id', { id: reviewId })
      .execute();
    const updated = await this.teacherReviewsRepository.findOne({
      where: { id: reviewId },
      select: { id: true, helpful_count: true },
    });
    return updated?.helpful_count ?? 0;
  }

  /** Remove any helpful votes attached to a review being deleted. */
  private async deleteReviewRow(type: ReviewTargetType, reviewId: string): Promise<void> {
    await this.helpfulVotesRepository.delete({
      review_type: type,
      review_id: reviewId,
    });
  }
}
