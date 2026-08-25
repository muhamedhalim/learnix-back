import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonStatus } from '../../src/lessons/entities/lesson-status.enum';
import { MeetingCreationStatus } from '../../src/lessons/entities/meeting-creation-status.enum';
import { ScheduledLessonSession } from '../../src/lessons/entities/scheduled-lesson-session.entity';
import { LessonSessionsService } from '../../src/lessons/lesson-sessions.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * Phase 9 / Phase 1-2 regression. The public shop surface for an Individual
 * Lesson: `is_group` + `available_sessions_count` + `next_session_at` on the
 * list, and the AD-11 sellability gate (a booked slot disappears
 * automatically, no new logic needed) — all against a real Postgres
 * database. `meeting_url` must never appear anywhere in a guest-facing
 * response, which is asserted with a recursive scan rather than spot checks
 * so a future field addition to `PublicLessonResponseDto` can't reintroduce
 * the leak unnoticed.
 */
describe('individual lesson shop surface (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let sessions: LessonSessionsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    sessions = app.get(LessonSessionsService);
  });
  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  /** Recursively asserts no key in `value` is named (or starts with) `meeting`. */
  function assertNoMeetingField(value: unknown, path = 'body'): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoMeetingField(item, `${path}[${String(index)}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase().includes('meeting')) {
        throw new Error(`Unexpected meeting-related field "${key}" found at ${path}.${key}`);
      }
      assertNoMeetingField(nested, `${path}.${key}`);
    }
  }

  async function makeSubject(): Promise<Subject> {
    const repository = dataSource.getRepository(Subject);
    return repository.save(
      repository.create({
        name: `Shop subject ${Date.now().toString()}`,
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
  }

  /** Published directly (bypassing the full publish workflow's unrelated preconditions — that path is covered elsewhere). */
  async function makePublishedIndividualLesson(teacherId: string, subjectId: string): Promise<Lesson> {
    const repository = dataSource.getRepository(Lesson);
    const lesson = await repository.save(
      repository.create({
        title: 'Shop-listed one-to-one lesson',
        description: 'desc',
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 500,
        duration: 3_600,
        is_group: false,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    lesson.status = LessonStatus.PUBLISHED;
    return repository.save(lesson);
  }

  async function createReadyAppointment(lessonId: string, teacherId: string): Promise<ScheduledLessonSession> {
    const [created] = await sessions.createMany(lessonId, teacherId, [
      {
        start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        meeting_url: 'https://meet.example.test/shop-listed',
      },
    ]);
    if (!created) throw new Error('Expected createMany to return exactly one session');
    return created;
  }

  it('the public lesson list exposes is_group, available_sessions_count and next_session_at, never meeting_url', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makePublishedIndividualLesson(teacher.userId, subject.id);
    await createReadyAppointment(lesson.id, teacher.userId);

    const response = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons`)
      .query({ is_group: false, subject_id: subject.id })
      .expect(200);

    const rows = (response.body as { data: Array<Record<string, unknown>> }).data;
    const listed = rows.find((row) => row['id'] === lesson.id);
    expect(listed).toMatchObject({ is_group: false, available_sessions_count: 1 });
    expect(listed?.['next_session_at']).not.toBeNull();
    assertNoMeetingField(response.body);
  });

  it('the public single-lesson response also carries available_sessions_count and never meeting_url', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makePublishedIndividualLesson(teacher.userId, subject.id);
    await createReadyAppointment(lesson.id, teacher.userId);

    const response = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}`)
      .expect(200);

    expect(response.body).toMatchObject({ id: lesson.id, is_group: false, available_sessions_count: 1 });
    assertNoMeetingField(response.body);
  });

  it('a held booking removes the slot from available_sessions_count and from the public appointment list (AD-11)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const student = await createAuthenticatedUser(app, dataSource, { role: 'student' });
    const subject = await makeSubject();
    const lesson = await makePublishedIndividualLesson(teacher.userId, subject.id);
    const appointment = await createReadyAppointment(lesson.id, teacher.userId);
    expect(appointment.meeting_status).toBe(MeetingCreationStatus.READY);

    const beforeReserve = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(beforeReserve.body).toHaveLength(1);

    await sessions.reserve(appointment.id, student.userId);

    const afterReserve = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(afterReserve.body).toHaveLength(0);

    const singleLesson = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}`)
      .expect(200);
    expect(singleLesson.body).toMatchObject({ available_sessions_count: 0, next_session_at: null });
  });

  it('a guest browsing the shop never sees a group lesson mixed into is_group=false results', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const individualLesson = await makePublishedIndividualLesson(teacher.userId, subject.id);
    await createReadyAppointment(individualLesson.id, teacher.userId);

    const groupRepository = dataSource.getRepository(Lesson);
    const groupLesson = await groupRepository.save(
      groupRepository.create({
        title: 'Shop-listed group lesson',
        description: 'desc',
        teacher_id: teacher.userId,
        subject_id: subject.id,
        thumbnail: null,
        price: 200,
        duration: 3_600,
        is_group: true,
        available_for_days: 7,
        students_count: 0,
        is_free_preview: false,
        status: LessonStatus.PUBLISHED,
      }),
    );

    const response = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons`)
      .query({ is_group: false, subject_id: subject.id })
      .expect(200);

    const rows = (response.body as { data: Array<Record<string, unknown>> }).data;
    expect(rows.some((row) => row['id'] === individualLesson.id)).toBe(true);
    expect(rows.some((row) => row['id'] === groupLesson.id)).toBe(false);
  });
});
