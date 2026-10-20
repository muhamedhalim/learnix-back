import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import type { CommentsService } from '../comments.service';
import { CommentsStudentController } from './comments-student.controller';

describe('CommentsStudentController', () => {
  // Every authentication path publishes this shape; it has `userId` and no `id` (FIA-001).
  const authenticatedStudent: JwtPayload = {
    userId: 'student-1',
    email: 'student@example.com',
    name: 'Student',
    role: 'student',
  };

  it('creates the comment as the authenticated student (userId)', async () => {
    const commentsService = {
      createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    } as unknown as CommentsService;
    const controller = new CommentsStudentController(commentsService);

    await controller.createComment('lesson-1', { comment_text: 'Question' }, authenticatedStudent);

    expect(commentsService.createComment).toHaveBeenCalledWith('lesson-1', 'student-1', {
      comment_text: 'Question',
    });
  });
});
