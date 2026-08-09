import { ForbiddenException, NotFoundException } from '@nestjs/common';

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
