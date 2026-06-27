import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { CreateReviewDto } from './dto/create-review.dto';
import { LessonReview } from './entities/lesson-review.entity';
import { TeacherReview } from './entities/teacher-review.entity';
import {
  ReviewAggregates,
  ReviewWithStudent,
} from './interfaces/review-aggregates.interface';

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
  ) {}

  /**
   * Validate if student has purchased ANY lesson from a teacher
   */
  private async validateStudentHasPurchasedFromTeacher(
    studentId: string,
    teacherId: string,
  ): Promise<boolean> {
    // Check direct lesson purchases from this teacher
    const directPurchase = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lessons', 'l', 'l.id = lp.lesson_id')
      .where('lp.student_id = :studentId', { studentId })
      .andWhere('l.teacher_id = :teacherId', { teacherId })
      .getOne();

    if (directPurchase) {
      return true;
    }

    // Check package purchases containing teacher's lessons
    const packagePurchase = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('lesson_packages', 'pkg', 'pkg.id = pp.package_id')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.package_id = pkg.id')
      .innerJoin('lessons', 'l', 'l.id = lpi.lesson_id')
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('l.teacher_id = :teacherId', { teacherId })
      .getOne();

    return !!packagePurchase;
  }

  /**
   * Validate if student has purchased a specific lesson
   */
  private async validateStudentHasPurchasedLesson(
    studentId: string,
    lessonId: string,
  ): Promise<boolean> {
    // Check direct lesson purchase
    const directPurchase = await this.lessonPurchasesRepository.findOne({
      where: {
        student_id: studentId,
        lesson_id: lessonId,
      },
    });

    if (directPurchase) {
      return true;
    }

    // Check package purchase
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
      .getOne();

    return !!packagePurchase;
  }

  /**
   * Create a teacher review
   */
  public async createTeacherReview(
    teacherId: string,
    studentId: string,
    dto: CreateReviewDto,
  ): Promise<TeacherReview> {
    // Validate teacher exists
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId, role: UserRole.TEACHER },
    });

    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    // Validate student has purchased from teacher
    const hasPurchase = await this.validateStudentHasPurchasedFromTeacher(
      studentId,
      teacherId,
    );

    if (!hasPurchase) {
      throw new ForbiddenException(
        'You must purchase a lesson from this teacher before reviewing',
      );
    }

    // Check for existing review
    const existingReview = await this.teacherReviewsRepository.findOne({
      where: { teacher_id: teacherId, student_id: studentId },
    });

    if (existingReview) {
      throw new ConflictException(
        'You have already reviewed this teacher. Reviews cannot be edited.',
      );
    }

    // Create review
    const review = this.teacherReviewsRepository.create({
      teacher_id: teacherId,
      student_id: studentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });

    return await this.teacherReviewsRepository.save(review);
  }

  /**
   * Get teacher reviews with aggregates
   */
  public async getTeacherReviews(
    teacherId: string,
    page = 1,
    limit = 20,
  ): Promise<
    PaginatedResponse<ReviewWithStudent> & { aggregates: ReviewAggregates }
  > {
    // Validate teacher exists
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId, role: UserRole.TEACHER },
    });

    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    // Get paginated reviews
    const [reviews, total] = await this.teacherReviewsRepository.findAndCount({
      where: { teacher_id: teacherId },
      relations: ['student'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Calculate aggregates
    const aggregates = await this.calculateTeacherAggregates(teacherId);

    // Format reviews
    const formattedReviews: ReviewWithStudent[] = reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      student: {
        id: review.student.id,
        name: review.student.name,
      },
      verified_purchase: true, // Always true for reviews
      created_at: review.created_at,
    }));

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      data: formattedReviews,
      meta,
      aggregates,
    };
  }

  /**
   * Calculate teacher review aggregates
   */
  private async calculateTeacherAggregates(
    teacherId: string,
  ): Promise<ReviewAggregates> {
    const reviews = await this.teacherReviewsRepository.find({
      where: { teacher_id: teacherId },
      select: ['rating'],
    });

    if (reviews.length === 0) {
      return {
        average_rating: 0,
        total_reviews: 0,
        rating_distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    reviews.forEach((review) => {
      distribution[review.rating as 1 | 2 | 3 | 4 | 5]++;
    });

    return {
      average_rating: Number.parseFloat((totalRating / reviews.length).toFixed(2)),
      total_reviews: reviews.length,
      rating_distribution: distribution,
    };
  }

  /**
   * Create a lesson review
   */
  public async createLessonReview(
    lessonId: string,
    studentId: string,
    dto: CreateReviewDto,
  ): Promise<LessonReview> {
    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    // Validate student has purchased lesson
    const hasPurchase = await this.validateStudentHasPurchasedLesson(
      studentId,
      lessonId,
    );

    if (!hasPurchase) {
      throw new ForbiddenException(
        'You must purchase this lesson before reviewing',
      );
    }

    // Check for existing review
    const existingReview = await this.lessonReviewsRepository.findOne({
      where: { lesson_id: lessonId, student_id: studentId },
    });

    if (existingReview) {
      throw new ConflictException(
        'You have already reviewed this lesson. Reviews cannot be edited.',
      );
    }

    // Create review
    const review = this.lessonReviewsRepository.create({
      lesson_id: lessonId,
      student_id: studentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });

    return await this.lessonReviewsRepository.save(review);
  }

  /**
   * Get lesson reviews with aggregates
   */
  public async getLessonReviews(
    lessonId: string,
    page = 1,
    limit = 20,
  ): Promise<
    PaginatedResponse<ReviewWithStudent> & { aggregates: ReviewAggregates }
  > {
    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    // Get paginated reviews
    const [reviews, total] = await this.lessonReviewsRepository.findAndCount({
      where: { lesson_id: lessonId },
      relations: ['student'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Calculate aggregates
    const aggregates = await this.calculateLessonAggregates(lessonId);

    // Format reviews
    const formattedReviews: ReviewWithStudent[] = reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      student: {
        id: review.student.id,
        name: review.student.name,
      },
      verified_purchase: true,
      created_at: review.created_at,
    }));

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      data: formattedReviews,
      meta,
      aggregates,
    };
  }

  /**
   * Calculate lesson review aggregates
   */
  private async calculateLessonAggregates(
    lessonId: string,
  ): Promise<ReviewAggregates> {
    const reviews = await this.lessonReviewsRepository.find({
      where: { lesson_id: lessonId },
      select: ['rating'],
    });

    if (reviews.length === 0) {
      return {
        average_rating: 0,
        total_reviews: 0,
        rating_distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    reviews.forEach((review) => {
      distribution[review.rating as 1 | 2 | 3 | 4 | 5]++;
    });

    return {
      average_rating: Number.parseFloat((totalRating / reviews.length).toFixed(2)),
      total_reviews: reviews.length,
      rating_distribution: distribution,
    };
  }
}
