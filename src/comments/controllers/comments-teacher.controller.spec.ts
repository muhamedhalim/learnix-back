import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import type { CommentsService } from '../comments.service';
import { CommentsTeacherController } from './comments-teacher.controller';

describe('CommentsTeacherController', () => {
  // Every authentication path publishes this shape; it has `userId` and no `id` (FIA-001).
  const authenticatedTeacher: JwtPayload = {
    userId: 'teacher-1',
    email: 'teacher@example.com',
    name: 'Teacher',
    role: 'teacher',
  };

  it('replies as the authenticated teacher (userId)', async () => {
    const commentsService = {
      addReply: jest.fn().mockResolvedValue({ id: 'reply-1' }),
    } as unknown as CommentsService;
    const controller = new CommentsTeacherController(commentsService);

    await controller.addReply('comment-1', { reply_text: 'Answer' }, authenticatedTeacher);

    expect(commentsService.addReply).toHaveBeenCalledWith('comment-1', 'teacher-1', {
      reply_text: 'Answer',
    });
  });
});
