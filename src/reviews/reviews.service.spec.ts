import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { LessonReview } from './entities/lesson-review.entity';
import {
  ReviewHelpfulVote,
  ReviewTargetType,
} from './entities/review-helpful-vote.entity';
import { ReviewStatus } from './entities/review-status.enum';
import { TeacherReview } from './entities/teacher-review.entity';
import { ReviewsService } from './reviews.service';
import { ApplicationCacheService } from '../common/cache/application-cache.service';

/** A chainable query-builder mock whose terminal calls resolve to `result`. */
function qbMock(result: unknown) {
  const qb: Record<string, jest.Mock> = {};
  const chain = [
    'innerJoin',
    'innerJoinAndSelect',
    'leftJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
    'update',
    'set',
    'groupBy',
    'addGroupBy',
    'limit',
  ];
  for (const m of chain) qb[m] = jest.fn(() => qb);
  qb.getOne = jest.fn().mockResolvedValue(result);
  qb.getRawMany = jest.fn().mockResolvedValue(result);
  qb.getManyAndCount = jest.fn().mockResolvedValue([result, 0]);
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
}

describe('ReviewsService', () => {
  let service: ReviewsService;

  const teacherReviews = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), remove: jest.fn(), create: jest.fn(), createQueryBuilder: jest.fn() };
  const lessonReviews = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), remove: jest.fn(), create: jest.fn(), createQueryBuilder: jest.fn() };
  const users = { findOne: jest.fn() };
  const lessons = { findOne: jest.fn() };
  const lessonPurchases = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const packagePurchases = { createQueryBuilder: jest.fn() };
  const lessonProgress = { findOne: jest.fn() };
  const helpfulVotes = { findOne: jest.fn(), save: jest.fn(), remove: jest.fn(), create: jest.fn(), delete: jest.fn(), createQueryBuilder: jest.fn() };
  const packages = { findOne: jest.fn() };
  const applicationCache = {
    getOrCompute: jest.fn((_descriptor: unknown, compute: () => unknown) => compute()),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    applicationCache.getOrCompute.mockImplementation(
      (_descriptor: unknown, compute: () => unknown) => compute(),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(TeacherReview), useValue: teacherReviews },
        { provide: getRepositoryToken(LessonReview), useValue: lessonReviews },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Lesson), useValue: lessons },
        { provide: getRepositoryToken(LessonPurchase), useValue: lessonPurchases },
        { provide: getRepositoryToken(PackagePurchase), useValue: packagePurchases },
        { provide: getRepositoryToken(LessonProgress), useValue: lessonProgress },
        { provide: getRepositoryToken(ReviewHelpfulVote), useValue: helpfulVotes },
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: ApplicationCacheService, useValue: applicationCache },
      ],
    }).compile();
    service = module.get(ReviewsService);
  });

  describe('createLessonReview — completion gate', () => {
    it('rejects when purchased but NOT completed', async () => {
      lessons.findOne.mockResolvedValue({ id: 'L1' });
      lessonPurchases.findOne.mockResolvedValue({ id: 'p1' }); // purchased
      lessonProgress.findOne.mockResolvedValue(null); // not completed

      await expect(
        service.createLessonReview('L1', 'S1', { rating: 5 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(lessonReviews.save).not.toHaveBeenCalled();
    });

    it('creates when purchased AND completed', async () => {
      lessons.findOne.mockResolvedValue({ id: 'L1' });
      lessonPurchases.findOne.mockResolvedValue({ id: 'p1' });
      lessonProgress.findOne.mockResolvedValue({ id: 'pr1' }); // completed
      lessonReviews.findOne.mockResolvedValue(null); // no existing review
      lessonReviews.create.mockImplementation((v: unknown) => v);
      lessonReviews.save.mockImplementation((v: unknown) => Promise.resolve(v));

      const result = await service.createLessonReview('L1', 'S1', {
        rating: 4,
        comment: 'Great',
      });
      expect(result).toMatchObject({ lesson_id: 'L1', rating: 4 });
    });
  });

  describe('replyToLessonReview — ownership', () => {
    it('forbids replying to another teacher\'s lesson review', async () => {
      lessonReviews.findOne.mockResolvedValue({
        id: 'r1',
        lesson: { teacher_id: 'other-teacher' },
      });
      await expect(
        service.replyToLessonReview('r1', 'teacher-1', 'thanks'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('saves the reply when the teacher owns the lesson', async () => {
      const review = { id: 'r1', lesson: { teacher_id: 'teacher-1' } } as unknown as LessonReview;
      lessonReviews.findOne.mockResolvedValue(review);
      lessonReviews.save.mockImplementation((v: unknown) => Promise.resolve(v));

      const result = await service.replyToLessonReview('r1', 'teacher-1', 'thanks');
      expect(result.teacher_reply).toBe('thanks');
      expect(result.teacher_reply_at).toBeInstanceOf(Date);
    });
  });

  describe('toggleHelpfulVote', () => {
    it('adds a vote and increments count when none exists', async () => {
      lessonReviews.findOne
        .mockResolvedValueOnce({ id: 'r1' }) // assertReviewExists
        .mockResolvedValueOnce({ id: 'r1', helpful_count: 1 }); // post-increment read
      helpfulVotes.findOne.mockResolvedValue(null);
      helpfulVotes.create.mockImplementation((v: unknown) => v);
      helpfulVotes.save.mockResolvedValue({});
      lessonReviews.createQueryBuilder.mockReturnValue(qbMock(null));

      const result = await service.toggleHelpfulVote(ReviewTargetType.LESSON, 'r1', 'U1');
      expect(result).toEqual({ helpful: true, helpful_count: 1 });
      expect(helpfulVotes.save).toHaveBeenCalled();
    });

    it('removes an existing vote and decrements count', async () => {
      lessonReviews.findOne
        .mockResolvedValueOnce({ id: 'r1' })
        .mockResolvedValueOnce({ id: 'r1', helpful_count: 0 });
      helpfulVotes.findOne.mockResolvedValue({ id: 'v1' });
      lessonReviews.createQueryBuilder.mockReturnValue(qbMock(null));

      const result = await service.toggleHelpfulVote(ReviewTargetType.LESSON, 'r1', 'U1');
      expect(result).toEqual({ helpful: false, helpful_count: 0 });
      expect(helpfulVotes.remove).toHaveBeenCalledWith({ id: 'v1' });
    });
  });

  describe('moderateReview', () => {
    it('sets the status on a lesson review', async () => {
      const review = { id: 'r1', status: ReviewStatus.APPROVED } as LessonReview;
      lessonReviews.findOne.mockResolvedValue(review);
      lessonReviews.save.mockResolvedValue(review);

      const result = await service.moderateReview(
        ReviewTargetType.LESSON,
        'r1',
        ReviewStatus.REJECTED,
      );
      expect(result).toEqual({ id: 'r1', status: ReviewStatus.REJECTED });
      expect(review.status).toBe(ReviewStatus.REJECTED);
    });

    it('404s for a missing review', async () => {
      teacherReviews.findOne.mockResolvedValue(null);
      await expect(
        service.moderateReview(ReviewTargetType.TEACHER, 'nope', ReviewStatus.FLAGGED),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
