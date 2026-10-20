import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import type { ReviewsService } from '../reviews.service';
import { ReviewsTeacherController } from './reviews-teacher.controller';

describe('ReviewsTeacherController', () => {
  // Every authentication path publishes this shape; it has `userId` and no `id` (FIA-001).
  const authenticatedTeacher: JwtPayload = {
    userId: 'teacher-1',
    email: 'teacher@example.com',
    name: 'Teacher',
    role: 'teacher',
  };

  function build(): { controller: ReviewsTeacherController; reviewsService: ReviewsService } {
    const reviewsService = {
      getTeacherLessonReviews: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      replyToLessonReview: jest.fn().mockResolvedValue({ id: 'review-1' }),
      replyToTeacherReview: jest.fn().mockResolvedValue({ id: 'review-2' }),
    } as unknown as ReviewsService;
    return { controller: new ReviewsTeacherController(reviewsService), reviewsService };
  }

  it('lists reviews for the authenticated teacher (userId)', async () => {
    const { controller, reviewsService } = build();

    await controller.myLessonReviews({ page: 2, limit: 10 } as never, authenticatedTeacher);

    expect(reviewsService.getTeacherLessonReviews).toHaveBeenCalledWith('teacher-1', 2, 10);
  });

  it('replies to a lesson review as the authenticated teacher', async () => {
    const { controller, reviewsService } = build();

    await controller.reply('review-1', { reply: 'Thanks' }, authenticatedTeacher);

    expect(reviewsService.replyToLessonReview).toHaveBeenCalledWith('review-1', 'teacher-1', 'Thanks');
  });

  it('replies to a profile review as the authenticated teacher', async () => {
    const { controller, reviewsService } = build();

    await controller.replyToProfileReview('review-2', { reply: 'Thanks' }, authenticatedTeacher);

    expect(reviewsService.replyToTeacherReview).toHaveBeenCalledWith('review-2', 'teacher-1', 'Thanks');
  });
});
