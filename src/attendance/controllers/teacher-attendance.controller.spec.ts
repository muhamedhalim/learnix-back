import { TeacherAttendanceController } from './teacher-attendance.controller';

describe('TeacherAttendanceController', () => {
  const attendanceService = {
    assertTeacherOwnsLesson: jest.fn(),
    updateAttendance: jest.fn(),
    deleteAttendance: jest.fn(),
  };
  const controller = new TeacherAttendanceController(attendanceService as never);
  const teacher = { userId: 'teacher-id' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('binds an attendance update to the validated lesson id', async () => {
    attendanceService.assertTeacherOwnsLesson.mockResolvedValue({
      id: 'lesson-id',
      teacher_id: 'teacher-id',
    });
    attendanceService.updateAttendance.mockResolvedValue({ id: 'attendance-id' });

    await controller.updateAttendance(teacher, 'lesson-id', 'attendance-id', { status: 'present' });

    expect(attendanceService.assertTeacherOwnsLesson).toHaveBeenCalledWith(
      'lesson-id',
      'teacher-id',
    );
    expect(attendanceService.updateAttendance).toHaveBeenCalledWith(
      'attendance-id',
      'lesson-id',
      'teacher-id',
      'present',
      undefined,
    );
  });

  it('binds an attendance delete to the validated lesson id', async () => {
    attendanceService.assertTeacherOwnsLesson.mockResolvedValue({
      id: 'lesson-id',
      teacher_id: 'teacher-id',
    });

    await controller.deleteAttendance(teacher, 'lesson-id', 'attendance-id');

    expect(attendanceService.deleteAttendance).toHaveBeenCalledWith('attendance-id', 'lesson-id');
  });
});
