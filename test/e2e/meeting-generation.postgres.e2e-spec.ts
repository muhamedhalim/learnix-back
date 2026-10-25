import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonSessionBookingStatus } from '../../src/lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionBooking } from '../../src/lessons/entities/lesson-session-booking.entity';
import { MeetingCreationStatus } from '../../src/lessons/entities/meeting-creation-status.enum';
import { MeetingProvider } from '../../src/lessons/entities/meeting-provider.enum';
import { ScheduledLessonSessionStatus } from '../../src/lessons/entities/scheduled-lesson-session-status.enum';
import { ScheduledLessonSession } from '../../src/lessons/entities/scheduled-lesson-session.entity';
import { TeacherMeetingAccount } from '../../src/lessons/entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from '../../src/lessons/entities/teacher-meeting-account-status.enum';
import { LessonSessionsService } from '../../src/lessons/lesson-sessions.service';
import { LessonsService } from '../../src/lessons/lessons.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * Phase 9. Exercises the explicit per-appointment meeting-generation flow
 * (Phase 5, AD-7) end-to-end against a real Postgres database: preconditions,
 * the AD-8 idempotency layers, Retry, and the AD-11/meeting-URL exposure
 * invariant. `GoogleMeetProvider` is swapped for a recording double (no real
 * OAuth app exists in CI) — everything above the provider boundary is real
 * code, including the queue-disabled-in-tests path: `provisionMeeting` is
 * invoked directly to simulate the worker, exactly as `NoopQueue` means no
 * real worker would otherwise consume the job in this suite (see
 * `areQueuesEnabled`).
 */
describe('meeting generation (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let sessions: LessonSessionsService;
  let lessons: LessonsService;
  let createMeeting: jest.Mock;

  beforeAll(async () => {
    createMeeting = jest.fn();
    ({ app, dataSource } = await createE2EApp({
      meetingProvider: {
        // `MeetingProviderRegistry` keys its map by `provider.name`
        // (`new Map(providers.map((p) => [p.name, p]))`). Without it the double
        // registers under `undefined`, `find(GOOGLE_MEET)` returns null, and
        // every Generate request fails the "provider not available" guard with
        // 400 before reaching the connected-account check this suite asserts.
        name: MeetingProvider.GOOGLE_MEET,
        isConfigured: () => true,
        getConfigurationStatus: () => ({ enabled: true, configured: true }),
        buildAuthorizeUrl: (state: string) => `https://accounts.google.com/o?state=${state}`,
        createMeeting,
        deleteMeeting: jest.fn().mockResolvedValue(undefined),
      },
    }));
    sessions = app.get(LessonSessionsService);
    lessons = app.get(LessonsService);
  });
  beforeEach(async () => {
    await resetDatabase(dataSource);
    createMeeting.mockReset();
  });
  afterAll(async () => app.close());

  async function makeSubject(): Promise<Subject> {
    const repository = dataSource.getRepository(Subject);
    return repository.save(
      repository.create({
        name: `Meeting subject ${Date.now().toString()}`,
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

  async function makeIndividualLesson(teacherId: string, subjectId: string): Promise<Lesson> {
    const repository = dataSource.getRepository(Lesson);
    return repository.save(
      repository.create({
        title: 'One-to-one meeting lesson',
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
  }

  /** `createMany` returns an array (bulk API); every call site here creates exactly one slot. */
  async function createAppointment(
    lessonId: string,
    teacherId: string,
    slot: { start_at: string; meeting_url?: string; meeting_provider?: MeetingProvider },
  ): Promise<ScheduledLessonSession> {
    const [created] = await sessions.createMany(lessonId, teacherId, [slot]);
    if (!created) throw new Error('Expected createMany to return exactly one session');
    return created;
  }

  async function connectAccount(teacherId: string): Promise<TeacherMeetingAccount> {
    const repository = dataSource.getRepository(TeacherMeetingAccount);
    return repository.save(
      repository.create({
        teacher_id: teacherId,
        provider: MeetingProvider.GOOGLE_MEET,
        provider_account_id: 'g-account-1',
        provider_account_email: 'teacher@example.test',
        display_name: 'Teacher',
        access_token_encrypted: 'access-token',
        refresh_token_encrypted: 'refresh-token',
        token_expires_at: new Date(Date.now() + 3_600_000),
        scopes: ['calendar.events'],
        status: TeacherMeetingAccountStatus.CONNECTED,
        last_verified_at: new Date(),
        last_error: null,
      }),
    );
  }

  it('creating an appointment leaves it not_requested with no meeting_url and no external call (negative test 1)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);

    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });

    expect(created.meeting_status).toBe(MeetingCreationStatus.NOT_REQUESTED);
    expect(created.meeting_url).toBeNull();
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it('rejects Generate with 409 MEETING_ACCOUNT_NOT_CONNECTED when the teacher has no connected account (negative test 2)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });

    const response = await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({})
      .expect(409);

    // `code` is the platform's error-contract extension point. The service also
    // attaches `provider` to the thrown body, but `HttpExceptionFilter` emits a
    // closed RFC 7807 shape (type/title/status/detail/instance/timestamp/
    // requestId/path/method/code/errors) and drops every other field by design,
    // so `provider` never reaches a client — no caller reads it either. The
    // assertion that carries meaning is the status plus the stable code.
    expect(response.body).toMatchObject({ code: 'MEETING_ACCOUNT_NOT_CONNECTED' });
    expect(createMeeting).not.toHaveBeenCalled();
    await expect(
      dataSource.getRepository(ScheduledLessonSession).findOneByOrFail({ id: created.id }),
    ).resolves.toMatchObject({ meeting_status: MeetingCreationStatus.NOT_REQUESTED });
  });

  it('rejects a second Generate once a meeting exists, and duplicate processing creates exactly one external meeting (AD-8, negative test 3)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    await connectAccount(teacher.userId);
    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });
    createMeeting.mockResolvedValue({
      externalId: 'ext-1',
      joinUrl: 'https://meet.google.com/abc-defg',
      hostUrl: 'https://calendar.google.com/event?eid=1',
      passcode: null,
    });

    const first = await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({});
    expect(first.status).toBe(201);
    // Queues are disabled for the E2E run (see `areQueuesEnabled`), so Generate
    // falls back to inline provisioning and the row is already `ready` — a
    // `pending` row with no consumer would otherwise be a permanent dead end.
    await expect(
      dataSource.getRepository(ScheduledLessonSession).findOneByOrFail({ id: created.id }),
    ).resolves.toMatchObject({ meeting_status: MeetingCreationStatus.READY });

    const second = await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({});
    expect(second.status).toBe(409);

    // Duplicate executions of the SAME job (as `MeetingProvisioningProcessor`
    // would make) must be no-ops (AD-8 layer 2's conditional claim) rather
    // than creating a second meeting.
    await sessions.provisionMeeting(created.id);
    await sessions.provisionMeeting(created.id);

    expect(createMeeting).toHaveBeenCalledTimes(1);
    const ready = await dataSource
      .getRepository(ScheduledLessonSession)
      .findOneByOrFail({ id: created.id });
    expect(ready.meeting_status).toBe(MeetingCreationStatus.READY);
    expect(ready.meeting_url).toBe('https://meet.google.com/abc-defg');
    expect(ready.external_meeting_id).toBe('ext-1');
  });

  it('accepts Retry on a failed appointment and reaches ready (negative test 4)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    await connectAccount(teacher.userId);
    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });

    createMeeting.mockRejectedValueOnce(new Error('provider unavailable'));
    await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({})
      .expect(201);
    await sessions.provisionMeeting(created.id);
    await expect(
      dataSource.getRepository(ScheduledLessonSession).findOneByOrFail({ id: created.id }),
    ).resolves.toMatchObject({ meeting_status: MeetingCreationStatus.FAILED });

    createMeeting.mockResolvedValueOnce({
      externalId: 'ext-retry-1',
      joinUrl: 'https://meet.google.com/retry-ok',
      hostUrl: null,
      passcode: null,
    });
    await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({})
      .expect(201);
    await sessions.provisionMeeting(created.id);

    await expect(
      dataSource.getRepository(ScheduledLessonSession).findOneByOrFail({ id: created.id }),
    ).resolves.toMatchObject({ meeting_status: MeetingCreationStatus.READY, meeting_url: 'https://meet.google.com/retry-ok' });
  });

  it('rejects Generate for a group lesson at precondition 2 and never calls the provider (negative test 6)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const groupLessonRepo = dataSource.getRepository(Lesson);
    const groupLesson = await groupLessonRepo.save(
      groupLessonRepo.create({
        title: 'Group lesson',
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
      }),
    );
    const sessionRepo = dataSource.getRepository(ScheduledLessonSession);
    const groupSession = await sessionRepo.save(
      sessionRepo.create({
        lesson_id: groupLesson.id,
        teacher_id: teacher.userId,
        start_at: new Date(Date.now() + 3 * 60 * 60_000),
        end_at: new Date(Date.now() + 4 * 60 * 60_000),
        status: ScheduledLessonSessionStatus.SCHEDULED,
        meeting_url: null,
        cancellation_reason: null,
        cancellation_requested_at: null,
        cancelled_at: null,
      }),
    );

    await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${groupLesson.id}/sessions/${groupSession.id}/meeting`)
      .send({ meeting_provider: MeetingProvider.GOOGLE_MEET })
      .expect(400);
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it('keeps a pre-existing manual meeting_url row ready and bookable with no teacher action (negative test 5)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const student = await createAuthenticatedUser(app, dataSource, { role: 'student' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    const manualSlot = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_url: 'https://meet.example.test/manual-link',
    });
    expect(manualSlot.meeting_status).toBe(MeetingCreationStatus.READY);
    expect(manualSlot.meeting_provider).toBe(MeetingProvider.MANUAL);

    const publicList = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(publicList.body).toHaveLength(1);
    expect(publicList.body[0]).not.toHaveProperty('meeting_url');

    const reservation = await sessions.reserve(manualSlot.id, student.userId);
    expect((reservation as { session: { meeting_url: string | null } }).session.meeting_url).toBeNull();
  });

  it('never exposes meeting_url until the booking is confirmed, and never exposes meeting_host_url/meeting_passcode to a student at all (exposure invariant, negative test 7)', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const student = await createAuthenticatedUser(app, dataSource, { role: 'student' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    await connectAccount(teacher.userId);
    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });
    createMeeting.mockResolvedValue({
      externalId: 'ext-exposure-1',
      joinUrl: 'https://meet.google.com/exposure-test',
      hostUrl: 'https://calendar.google.com/event?eid=exposure',
      passcode: '999999',
    });
    await teacher.agent
      .post(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions/${String(created.id)}/meeting`)
      .send({})
      .expect(201);
    await sessions.provisionMeeting(created.id);

    // Guest/public: the session list must not carry the field at all.
    const publicList = await request(app.getHttpServer() as Server)
      .get(`${API_PREFIX}/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(publicList.body[0]).not.toHaveProperty('meeting_url');
    expect(publicList.body[0]).not.toHaveProperty('meeting_host_url');

    // Student holds the slot but has not paid: null, and no host/passcode key at all.
    const held = (await sessions.reserve(created.id, student.userId)) as {
      session: { meeting_url: string | null };
    };
    expect(held.session.meeting_url).toBeNull();
    expect(held.session).not.toHaveProperty('meeting_host_url');
    expect(held.session).not.toHaveProperty('meeting_passcode');

    // Simulate payment confirmation the way `confirmForOrder` would leave the
    // booking, without pulling in the full order/payment machinery.
    const booking = await dataSource
      .getRepository(LessonSessionBooking)
      .findOneByOrFail({ scheduled_session_id: created.id, student_id: student.userId });
    booking.status = LessonSessionBookingStatus.CONFIRMED;
    booking.confirmed_at = new Date();
    await dataSource.getRepository(LessonSessionBooking).save(booking);

    const confirmed = (await sessions.listForStudent(student.userId))[0] as {
      session: { meeting_url: string | null };
    };
    expect(confirmed.session.meeting_url).toBe('https://meet.google.com/exposure-test');
    expect(confirmed.session).not.toHaveProperty('meeting_host_url');
    expect(confirmed.session).not.toHaveProperty('meeting_passcode');

    // Owner teacher and admin both see the full record, host URL included.
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const teacherView = await teacher.agent
      .get(`${API_PREFIX}/teacher/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(teacherView.body[0].meeting_host_url).toBe('https://calendar.google.com/event?eid=exposure');
    const adminView = await admin.agent
      .get(`${API_PREFIX}/admin/lessons/${lesson.id}/sessions`)
      .expect(200);
    expect(adminView.body[0].meeting_host_url).toBe('https://calendar.google.com/event?eid=exposure');
  });

  it('rejects publishing an individual lesson with no ready future appointment, and accepts it once one is ready', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const subject = await makeSubject();
    const lesson = await makeIndividualLesson(teacher.userId, subject.id);
    const created = await createAppointment(lesson.id, teacher.userId, {
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      meeting_provider: MeetingProvider.GOOGLE_MEET,
    });

    await expect(lessons.assertPublishable(lesson)).rejects.toBeInstanceOf(Error);

    await dataSource.getRepository(ScheduledLessonSession).update(
      { id: created.id },
      { meeting_status: MeetingCreationStatus.READY, meeting_url: 'https://meet.example.test/ready-for-publish' },
    );
    await expect(lessons.assertPublishable(lesson)).resolves.toBeUndefined();
  });
});
