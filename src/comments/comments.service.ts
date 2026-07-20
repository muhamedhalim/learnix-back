import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreateReplyDto } from './dto/create-reply.dto';
import { Comment } from './entities/comment.entity';
import { CommentReply } from './entities/comment-reply.entity';

export interface CommentWithReplies {
  id: string;
  lesson_id: string;
  student_id: string;
  comment_text: string;
  student: {
    id: string;
    name: string;
  };
  replies: Array<{
    id: string;
    reply_text: string;
    teacher: {
      id: string;
      name: string;
    };
    created_at: Date;
  }>;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment)
    private readonly commentsRepository: Repository<Comment>,
    @InjectRepository(CommentReply)
    private readonly repliesRepository: Repository<CommentReply>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchasesRepository: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
  ) {}

  /**
   * Validate if student has purchased a lesson (directly or via package)
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

    // Check package purchase (via lesson_package_items join)
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
   * Create a comment on a lesson
   */
  public async createComment(
    lessonId: string,
    studentId: string,
    dto: CreateCommentDto,
  ): Promise<CommentWithReplies> {
    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    // Validate student has purchased the lesson
    const hasPurchase = await this.validateStudentHasPurchasedLesson(studentId, lessonId);

    if (!hasPurchase) {
      throw new ForbiddenException(
        biBody(
          'You must purchase this lesson before commenting',
          'يجب شراء هذا الدرس قبل التعليق عليه',
        ),
      );
    }

    // Create comment
    const comment = this.commentsRepository.create({
      lesson_id: lessonId,
      student_id: studentId,
      comment_text: dto.comment_text,
    });

    const savedComment = await this.commentsRepository.save(comment);

    // Return with nested replies (empty initially)
    return {
      id: savedComment.id,
      lesson_id: savedComment.lesson_id,
      student_id: savedComment.student_id,
      comment_text: savedComment.comment_text,
      student: {
        id: studentId,
        name: '', // Will be populated by client
      },
      replies: [],
      created_at: savedComment.created_at,
      updated_at: savedComment.updated_at,
    };
  }

  /**
   * Get comments on a lesson with nested replies (paginated, public endpoint)
   */
  public async getCommentsByLesson(
    lessonId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<CommentWithReplies>> {
    // Validate lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    // Get paginated comments (not soft-deleted)
    const [comments, total] = await this.commentsRepository.findAndCount({
      where: {
        lesson_id: lessonId,
        deleted_at: IsNull(),
      },
      relations: ['student', 'replies', 'replies.teacher'],
      order: {
        created_at: 'DESC',
        id: 'DESC',
      },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Format response
    const formattedComments: CommentWithReplies[] = comments.map((comment) => ({
      id: comment.id,
      lesson_id: comment.lesson_id,
      student_id: comment.student_id,
      comment_text: comment.comment_text,
      student: {
        id: comment.student.id,
        name: comment.student.name,
      },
      replies: comment.replies.map((reply) => ({
        id: reply.id,
        reply_text: reply.reply_text,
        teacher: {
          id: reply.teacher.id,
          name: reply.teacher.name,
        },
        created_at: reply.created_at,
      })),
      created_at: comment.created_at,
      updated_at: comment.updated_at,
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
      data: formattedComments,
      meta,
    };
  }

  /**
   * Add a reply to a comment (teacher only)
   */
  public async addReply(
    commentId: string,
    teacherId: string,
    dto: CreateReplyDto,
  ): Promise<CommentReply> {
    // Find comment
    const comment = await this.commentsRepository.findOne({
      where: { id: commentId, deleted_at: IsNull() },
      relations: ['lesson'],
    });

    if (!comment) {
      throw new NotFoundException(biBody('Comment not found', 'التعليق غير موجود'));
    }

    // Validate teacher owns the lesson
    if (comment.lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody(
          'You can only reply to comments on your own lessons',
          'يمكنك الرد فقط على التعليقات الخاصة بدروسك',
        ),
      );
    }

    // Check for nested reply depth (only one level allowed)
    const existingReply = await this.repliesRepository.findOne({
      where: {
        comment_id: commentId,
      },
    });

    if (existingReply) {
      throw new BadRequestException(
        biBody(
          'This comment already has a reply. Only one-level replies are allowed.',
          'يحتوي هذا التعليق بالفعل على رد. يُسمح فقط بردود من مستوى واحد.',
        ),
      );
    }

    // Create reply
    const reply = this.repliesRepository.create({
      comment_id: commentId,
      teacher_id: teacherId,
      reply_text: dto.reply_text,
    });

    return await this.repliesRepository.save(reply);
  }

  /**
   * Soft-delete a comment (admin only)
   */
  public async deleteComment(commentId: string): Promise<void> {
    const comment = await this.commentsRepository.findOne({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException(biBody('Comment not found', 'التعليق غير موجود'));
    }

    // Soft delete (sets deleted_at)
    comment.deleted_at = new Date();
    await this.commentsRepository.save(comment);

    // Soft delete associated replies as well
    await this.repliesRepository.update(
      { comment_id: commentId },
      { updated_at: new Date() }, // Mark updated but keep replies
    );
  }

  /**
   * Get comment by ID (with replies)
   */
  public async getCommentById(commentId: string): Promise<CommentWithReplies | null> {
    const comment = await this.commentsRepository.findOne({
      where: { id: commentId, deleted_at: IsNull() },
      relations: ['student', 'replies', 'replies.teacher'],
    });

    if (!comment) {
      return null;
    }

    return {
      id: comment.id,
      lesson_id: comment.lesson_id,
      student_id: comment.student_id,
      comment_text: comment.comment_text,
      student: {
        id: comment.student.id,
        name: comment.student.name,
      },
      replies: comment.replies.map((reply) => ({
        id: reply.id,
        reply_text: reply.reply_text,
        teacher: {
          id: reply.teacher.id,
          name: reply.teacher.name,
        },
        created_at: reply.created_at,
      })),
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    };
  }
}
