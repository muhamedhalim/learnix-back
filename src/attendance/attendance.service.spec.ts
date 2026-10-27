import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { AttendanceService } from './attendance.service';
import type { AttendanceRecord } from './entities/attendance-record.entity';

describe('AttendanceService record ownership scope', () => {
  const attendanceRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
  };
  const lessonsRepository = { findOne: jest.fn() };
  const payments = { hasLessonPlaybackAccess: jest.fn() };

  const service = new AttendanceService(
    attendanceRepository as never,
    {} as never,
    lessonsRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    payments as never,
  );

  beforeEach(() => jest.clearAllMocks());

  describe('assertTeacherOwnsLesson', () => {
    it('returns the lesson for its owner', async () => {
      const lesson = { id: 'lesson-id', teacher_id: 'teacher-id' };
      lessonsRepository.findOne.mockResolvedValue(lesson);

      await expect(service.assertTeacherOwnsLesson('lesson-id', 'teacher-id')).resolves.toBe(
        lesson,
      );
    });

    it('answers 403 (not 404) for a lesson that does not exist or is soft-deleted', async () => {
      lessonsRepository.findOne.mockResolvedValue(null);

      await expect(service.assertTeacherOwnsLesson('missing', 'teacher-id')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("answers 403 for another teacher's lesson", async () => {
      lessonsRepository.findOne.mockResolvedValue({ id: 'lesson-id', teacher_id: 'someone-else' });

      await expect(
        service.assertTeacherOwnsLesson('lesson-id', 'teacher-id'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('updates only a record belonging to the route lesson', async () => {
    const attendance = { id: 'attendance-id', lesson_id: 'lesson-id' } as AttendanceRecord;
    attendanceRepository.findOne.mockResolvedValue(attendance);
    attendanceRepository.save.mockResolvedValue(attendance);

    await service.updateAttendance('attendance-id', 'lesson-id', 'teacher-id', 'present');

    expect(attendanceRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'attendance-id', lesson_id: 'lesson-id' },
      relations: ['student', 'lesson', 'marker'],
    });
    expect(attendanceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ marked_by: 'teacher-id', status: 'present' }),
    );
  });

  it('refuses to delete a record from a different lesson', async () => {
    attendanceRepository.findOne.mockResolvedValue(null);

    await expect(
      service.deleteAttendance('other-attendance-id', 'lesson-id'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(attendanceRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'other-attendance-id', lesson_id: 'lesson-id' },
      relations: ['student', 'lesson', 'marker'],
    });
    expect(attendanceRepository.remove).not.toHaveBeenCalled();
  });

  it('rejects attendance for a student without active lesson enrollment', async () => {
    attendanceRepository.findOne.mockResolvedValue(null);
    lessonsRepository.findOne.mockResolvedValue({ id: 'lesson-id', title: 'Chemistry' });
    payments.hasLessonPlaybackAccess.mockResolvedValue(false);

    await expect(
      service.markAttendance('teacher-id', {
        student_id: 'student-id',
        lesson_id: 'lesson-id',
        status: 'present',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(payments.hasLessonPlaybackAccess).toHaveBeenCalledWith('student-id', 'lesson-id');
    expect(attendanceRepository.create).not.toHaveBeenCalled();
    expect(attendanceRepository.save).not.toHaveBeenCalled();
  });
});

describe('AttendanceService existence checks (T083)', () => {
  const attendanceRepository = { exists: jest.fn(), create: jest.fn(), save: jest.fn() };
  const lessonsRepository = { exists: jest.fn() };
  const scheduledSessions = { findOne: jest.fn() };
  const bookings = { findOne: jest.fn() };

  const service = new AttendanceService(
    attendanceRepository as never,
    {} as never,
    lessonsRepository as never,
    scheduledSessions as never,
    bookings as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('answers 409 for an already-marked appointment using an existence probe on exactly the pair', async () => {
    scheduledSessions.findOne.mockResolvedValue({ id: 'session-1', lesson: { title: 'L' } });
    bookings.findOne.mockResolvedValue({ id: 'booking-1' });
    attendanceRepository.exists.mockResolvedValue(true);

    await expect(
      service.markScheduledSessionAttendance('marker', 'lesson-1', 'session-1', {
        student_id: 'student-1',
        status: 'present',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    // attendance_records has no deleted_at: the where must stay exactly the pair.
    expect(attendanceRepository.exists).toHaveBeenCalledWith({
      where: { student_id: 'student-1', scheduled_lesson_session_id: 'session-1' },
    });
    expect(attendanceRepository.create).not.toHaveBeenCalled();
  });

  it('answers 404 when the lesson is missing or soft-deleted, probing only existence', async () => {
    lessonsRepository.exists.mockResolvedValue(false);

    await expect(service.enterLesson('student-1', 'lesson-9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(lessonsRepository.exists).toHaveBeenCalledWith({
      where: { id: 'lesson-9', deleted_at: expect.anything() },
    });
  });
});
