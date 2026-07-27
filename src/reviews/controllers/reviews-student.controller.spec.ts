import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ReviewsService } from '../reviews.service';
import { ReviewsStudentController } from './reviews-student.controller';

describe('ReviewsStudentController', () => {
  const authenticatedStudent: JwtPayload = {
    userId: 'student-1',
    email: 'student@example.com',
    name: 'Student',
    role: 'student',
  };

  it('uses the authenticated userId when updating a lesson review', async () => {
    const reviewsService = {
      updateLessonReview: jest.fn().mockResolvedValue({ id: 'review-1' }),
    } as unknown as ReviewsService;
    const controller = new ReviewsStudentController(reviewsService);

    await controller.updateLessonReview(
      'lesson-1',
      { rating: 5, comment: 'Updated feedback' },
      authenticatedStudent,
    );

    expect(reviewsService.updateLessonReview).toHaveBeenCalledWith('lesson-1', 'student-1', {
      rating: 5,
      comment: 'Updated feedback',
    });
  });
});
