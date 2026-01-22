import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommentsService } from './comments.service';
import { Comment } from './entities/comment.entity';
import { CommentReply } from './entities/comment-reply.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

describe('CommentsService', () => {
  let service: CommentsService;
  let commentsRepository: Repository<Comment>;
  let repliesRepository: Repository<CommentReply>;
  let lessonsRepository: Repository<Lesson>;
  let lessonPurchasesRepository: Repository<LessonPurchase>;
  let packagePurchasesRepository: Repository<PackagePurchase>;

  const mockLessonId = 'lesson-123';
  const mockStudentId = 'student-123';
  const mockTeacherId = 'teacher-123';
  const mockCommentId = 'comment-123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        {
          provide: getRepositoryToken(Comment),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(CommentReply),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Lesson),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(LessonPurchase),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(PackagePurchase),
          useValue: {
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
    commentsRepository = module.get<Repository<Comment>>(
      getRepositoryToken(Comment),
    );
    repliesRepository = module.get<Repository<CommentReply>>(
      getRepositoryToken(CommentReply),
    );
    lessonsRepository = module.get<Repository<Lesson>>(
      getRepositoryToken(Lesson),
    );
    lessonPurchasesRepository = module.get<Repository<LessonPurchase>>(
      getRepositoryToken(LessonPurchase),
    );
    packagePurchasesRepository = module.get<Repository<PackagePurchase>>(
      getRepositoryToken(PackagePurchase),
    );
  });

  describe('createComment', () => {
    it('should create a comment when student has direct lesson purchase', async () => {
      const dto = { comment_text: 'Great lesson!' };

      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue({
        id: mockLessonId,
        teacher_id: mockTeacherId,
        deleted_at: null,
      } as Lesson);

      jest.spyOn(lessonPurchasesRepository, 'findOne').mockResolvedValue({
        id: 'purchase-123',
        student_id: mockStudentId,
        lesson_id: mockLessonId,
      } as LessonPurchase);

      const mockComment = {
        id: mockCommentId,
        lesson_id: mockLessonId,
        student_id: mockStudentId,
        comment_text: dto.comment_text,
        created_at: new Date(),
        updated_at: new Date(),
      };

      jest
        .spyOn(commentsRepository, 'create')
        .mockReturnValue(mockComment as Comment);
      jest
        .spyOn(commentsRepository, 'save')
        .mockResolvedValue(mockComment as Comment);

      const result = await service.createComment(
        mockLessonId,
        mockStudentId,
        dto,
      );

      expect(result.comment_text).toBe(dto.comment_text);
      expect(result.replies).toEqual([]);
    });

    it('should create a comment when student has package purchase', async () => {
      const dto = { comment_text: 'Great lesson!' };

      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue({
        id: mockLessonId,
        teacher_id: mockTeacherId,
      } as Lesson);

      jest.spyOn(lessonPurchasesRepository, 'findOne').mockResolvedValue(null);

      const mockQueryBuilder = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'package-123' }),
      };

      jest
        .spyOn(packagePurchasesRepository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as never);

      const mockComment = {
        id: mockCommentId,
        lesson_id: mockLessonId,
        student_id: mockStudentId,
        comment_text: dto.comment_text,
        created_at: new Date(),
        updated_at: new Date(),
      };

      jest
        .spyOn(commentsRepository, 'create')
        .mockReturnValue(mockComment as Comment);
      jest
        .spyOn(commentsRepository, 'save')
        .mockResolvedValue(mockComment as Comment);

      const result = await service.createComment(
        mockLessonId,
        mockStudentId,
        dto,
      );

      expect(result.comment_text).toBe(dto.comment_text);
    });

    it('should throw ForbiddenException when student has no purchase', async () => {
      const dto = { comment_text: 'Great lesson!' };

      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue({
        id: mockLessonId,
        teacher_id: mockTeacherId,
      } as Lesson);

      jest.spyOn(lessonPurchasesRepository, 'findOne').mockResolvedValue(null);

      const mockQueryBuilder2 = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };

      jest
        .spyOn(packagePurchasesRepository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder2 as never);

      await expect(
        service.createComment(mockLessonId, mockStudentId, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when lesson does not exist', async () => {
      const dto = { comment_text: 'Great lesson!' };

      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.createComment(mockLessonId, mockStudentId, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCommentsByLesson', () => {
    it('should return paginated comments with replies', async () => {
      const mockComment = {
        id: mockCommentId,
        lesson_id: mockLessonId,
        student_id: mockStudentId,
        comment_text: 'Great lesson!',
        student: { id: mockStudentId, name: 'Student Name' },
        replies: [
          {
            id: 'reply-123',
            reply_text: 'Thank you!',
            teacher: { id: mockTeacherId, name: 'Teacher Name' },
            created_at: new Date(),
          },
        ],
        created_at: new Date(),
        updated_at: new Date(),
      };

      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue({
        id: mockLessonId,
      } as Lesson);

      jest
        .spyOn(commentsRepository, 'findAndCount')
        .mockResolvedValue([[mockComment as unknown as Comment], 1]);

      const result = await service.getCommentsByLesson(mockLessonId, 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].comment_text).toBe('Great lesson!');
      expect(result.data[0].replies).toHaveLength(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.total).toBe(1);
    });

    it('should throw NotFoundException when lesson does not exist', async () => {
      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.getCommentsByLesson(mockLessonId, 1, 20),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle pagination correctly', async () => {
      jest.spyOn(lessonsRepository, 'findOne').mockResolvedValue({
        id: mockLessonId,
      } as Lesson);

      jest
        .spyOn(commentsRepository, 'findAndCount')
        .mockResolvedValue([[], 50]);

      const result = await service.getCommentsByLesson(mockLessonId, 2, 20);

      expect(result.meta.page).toBe(2);
      expect(result.meta.totalPages).toBe(3);
      expect(result.meta.hasNextPage).toBe(true);
      expect(result.meta.hasPrevPage).toBe(true);
    });
  });

  describe('addReply', () => {
    it('should add reply when teacher owns the lesson', async () => {
      const dto = { reply_text: 'Thank you for the question!' };

      const mockComment = {
        id: mockCommentId,
        lesson_id: mockLessonId,
        lesson: { id: mockLessonId, teacher_id: mockTeacherId },
      } as unknown as Comment;

      jest.spyOn(commentsRepository, 'findOne').mockResolvedValue(mockComment);

      jest.spyOn(repliesRepository, 'findOne').mockResolvedValue(null);

      const mockReply = {
        id: 'reply-123',
        comment_id: mockCommentId,
        teacher_id: mockTeacherId,
        reply_text: dto.reply_text,
        created_at: new Date(),
        updated_at: new Date(),
      };

      jest
        .spyOn(repliesRepository, 'create')
        .mockReturnValue(mockReply as CommentReply);
      jest
        .spyOn(repliesRepository, 'save')
        .mockResolvedValue(mockReply as CommentReply);

      const result = await service.addReply(mockCommentId, mockTeacherId, dto);

      expect(result.reply_text).toBe(dto.reply_text);
    });

    it('should throw ForbiddenException when teacher does not own lesson', async () => {
      const dto = { reply_text: 'Thank you!' };
      const differentTeacherId = 'other-teacher-123';

      const mockComment = {
        id: mockCommentId,
        lesson: { id: mockLessonId, teacher_id: mockTeacherId },
      } as unknown as Comment;

      jest.spyOn(commentsRepository, 'findOne').mockResolvedValue(mockComment);

      await expect(
        service.addReply(mockCommentId, differentTeacherId, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when comment already has reply', async () => {
      const dto = { reply_text: 'Thank you!' };

      const mockComment = {
        id: mockCommentId,
        lesson: { id: mockLessonId, teacher_id: mockTeacherId },
      } as unknown as Comment;

      jest.spyOn(commentsRepository, 'findOne').mockResolvedValue(mockComment);

      jest.spyOn(repliesRepository, 'findOne').mockResolvedValue({
        id: 'existing-reply',
      } as CommentReply);

      await expect(
        service.addReply(mockCommentId, mockTeacherId, dto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteComment', () => {
    it('should soft-delete a comment', async () => {
      const mockComment = {
        id: mockCommentId,
        deleted_at: null,
      } as Comment;

      jest.spyOn(commentsRepository, 'findOne').mockResolvedValue(mockComment);

      jest.spyOn(commentsRepository, 'save').mockResolvedValue({
        ...mockComment,
        deleted_at: new Date(),
      } as Comment);

      await service.deleteComment(mockCommentId);

      expect(jest.spyOn(commentsRepository, 'save')).toHaveBeenCalled();
    });

    it('should throw NotFoundException when comment does not exist', async () => {
      jest.spyOn(commentsRepository, 'findOne').mockResolvedValue(null);

      await expect(service.deleteComment(mockCommentId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
