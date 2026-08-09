import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonSessionBookingStatus } from '../../src/lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from '../../src/lessons/entities/lesson-session-booking.entity';
import { ScheduledLessonSessionStatus } from '../../src/lessons/entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from '../../src/lessons/entities/scheduled-lesson-session.entity';
import { LessonSessionsService } from '../../src/lessons/lesson-sessions.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';

describe('one-to-one reservation concurrency (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: LessonSessionsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    service = app.get(LessonSessionsService);
  });
  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  it('allows exactly one active booking for a slot while another slot stays independent', async () => {
    const users = dataSource.getRepository(User);
    const makeUser = async (suffix: string, role: UserRole) =>
      users.save(
        users.create({
          username: `session-${suffix}`,
          name: `Session ${suffix}`,
          first_name: null,
          last_name: null,
          email: `session-${suffix}@example.test`,
          phone: `01088${suffix.padStart(6, '0')}`,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await makeUser('1', UserRole.TEACHER);
    const studentA = await makeUser('2', UserRole.STUDENT);
    const studentB = await makeUser('3', UserRole.STUDENT);
    const subject = await dataSource.getRepository(Subject).save(
      dataSource.getRepository(Subject).create({
        name: 'Concurrency subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lesson = await dataSource.getRepository(Lesson).save(
      dataSource.getRepository(Lesson).create({
        title: 'Concurrent booking lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 500,
        duration: 3_600,
        is_group: false,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const start = new Date(Date.now() + 48 * 60 * 60_000);
    const makeSlot = async (offsetHours: number) => {
      const startAt = new Date(start.getTime() + offsetHours * 60 * 60_000);
      return dataSource.getRepository(ScheduledLessonSession).save(
        dataSource.getRepository(ScheduledLessonSession).create({
          lesson_id: lesson.id,
          teacher_id: teacher.id,
          start_at: startAt,
          end_at: new Date(startAt.getTime() + 3_600_000),
          status: ScheduledLessonSessionStatus.SCHEDULED,
          meeting_url: 'https://meet.example.test/private-room',
          cancellation_reason: null,
          cancellation_requested_at: null,
          cancelled_at: null,
        }),
      );
    };
    const firstSlot = await makeSlot(0);
    const secondSlot = await makeSlot(24);

    const attempts = await Promise.allSettled([
      service.reserve(firstSlot.id, studentA.id),
      service.reserve(firstSlot.id, studentB.id),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(ConflictException) });

    const activeBooking = await dataSource.getRepository(LessonSessionBooking).findOneOrFail({
      where: {
        scheduled_session_id: firstSlot.id,
        status: LessonSessionBookingStatus.HELD,
      },
    });
    expect(
      await dataSource.getRepository(LessonSessionBooking).countBy({
        scheduled_session_id: firstSlot.id,
        status: LessonSessionBookingStatus.HELD,
      }),
    ).toBe(1);

    const otherStudent = activeBooking.student_id === studentA.id ? studentB.id : studentA.id;
    await expect(service.reserve(secondSlot.id, otherStudent)).resolves.toMatchObject({
      status: LessonSessionBookingStatus.HELD,
      session: { id: secondSlot.id },
    });
  });
});
