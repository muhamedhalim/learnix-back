import { StudentProfileController } from './student-profile.controller';

describe('StudentProfileController.getProfile', () => {
  it('returns a successful profile payload when historical related records are null', async () => {
    const profile = {
      id: 'student-profile-id',
      purchasedLessons: [{ lessonId: 'deleted-lesson-id', title: null }],
      exams: [{ examId: 'deleted-exam-id', title: null, totalMarks: null }],
    };
    const studentsService = { findStudentProfile: jest.fn().mockResolvedValue(profile) };
    const controller = new StudentProfileController(studentsService as never);

    await expect(controller.getProfile({ userId: 'student-user-id' } as never)).resolves.toEqual({
      profile,
    });
    expect(studentsService.findStudentProfile).toHaveBeenCalledWith('student-user-id');
  });
});
