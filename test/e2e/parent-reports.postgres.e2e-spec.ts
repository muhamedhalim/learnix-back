import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { DataSource, Repository } from 'typeorm';

import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import {
  Guardian,
  GuardianRelationship,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from '../../src/guardians/entities';
import { GuardiansService } from '../../src/guardians/guardians.service';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { ParentNotificationJobsService } from '../../src/notifications/services/parent-notification-jobs.service';
import { ParentReportStatus } from '../../src/parent-reports/entities/parent-report-status.enum';
import { ParentReportType } from '../../src/parent-reports/entities/parent-report-type.enum';
import { ParentReport } from '../../src/parent-reports/entities/parent-report.entity';
import {
  resolveMonthlyPeriod,
  resolveWeeklyPeriod,
  type ReportPeriod,
} from '../../src/parent-reports/logic/report-period';
import { ParentReportProcessor } from '../../src/parent-reports/processors/parent-report.processor';
import { ParentReportAggregatorService } from '../../src/parent-reports/services/parent-report-aggregator.service';
import { ParentReportService } from '../../src/parent-reports/services/parent-report.service';
import { ParentReportJobsService } from '../../src/parent-reports/services/parent-report-jobs.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';

/**
 * DEF-006 — proof against real PostgreSQL that weekly/monthly guardian reports
 * aggregate the right window, honour the guardian toggles, and cannot be sent
 * twice.
 *
 * Two things are deliberately NOT substituted: the period arithmetic and the
 * database. Every boundary assertion below inserts rows on both sides of a real
 * timestamptz boundary and reads what Postgres actually returns, because the
 * whole defect class here — off-by-one weeks, UTC-vs-local drift, duplicate
 * sends after a restart — only ever shows up against a real engine.
 *
 * The only double is the outbound queue: `enqueueDelivery` is spied on, so the
 * assertion "a guardian message was produced" is made at the exact seam where
 * the report engine hands over to the DEF-005 pipeline. Everything below that
 * seam is already covered by the DEF-005 suites.
 */
jest.setTimeout(120_000);

/** Africa/Cairo. Monday 2026-08-10 ⇒ last complete week is 3–9 August. */
const MONDAY = new Date('2026-08-10T06:00:00.000Z');
const CAIRO = 'Africa/Cairo';

describe('DEF-006 · parent periodic reports (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let aggregator: ParentReportAggregatorService;
  let reports: ParentReportService;
  let guardians: GuardiansService;
  let processor: ParentReportProcessor;
  let enqueueDelivery: jest.SpyInstance;
  let enqueueBuildBatch: jest.SpyInstance;

  let weekly: ReportPeriod;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());

    aggregator = app.get(ParentReportAggregatorService);
    reports = app.get(ParentReportService);
    guardians = app.get(GuardiansService);

    const notificationJobs = app.get(ParentNotificationJobsService);
    const reportJobs = app.get(ParentReportJobsService);
    enqueueDelivery = jest.spyOn(notificationJobs, 'enqueueDelivery').mockResolvedValue();
    enqueueBuildBatch = jest.spyOn(reportJobs, 'enqueueBuildBatch').mockResolvedValue();

    // Workers are disabled in the E2E environment (E2E_DISABLE_BACKGROUND_WORKERS),
    // so the processor is not in the container. Constructing it by hand runs the
    // real production code against the real services and the real database — the
    // only thing missing is BullMQ handing it the job.
    processor = new ParentReportProcessor(
      guardians,
      aggregator,
      reports,
      reportJobs,
      notificationJobs,
      app.get<Repository<User>>(getRepositoryToken(User)),
    );

    weekly = resolveWeeklyPeriod(MONDAY, CAIRO);
  });

  afterAll(async () => {
    enqueueDelivery.mockRestore();
    enqueueBuildBatch.mockRestore();
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    enqueueDelivery.mockClear();
    enqueueBuildBatch.mockClear();
  });

  /* ------------------------------- fixtures -------------------------------- */

  let seq = 0;

  async function makeUser(role: UserRole): Promise<User> {
    seq += 1;
    const users = dataSource.getRepository(User);
    return await users.save(
      users.create({
        username: `def006-${String(seq)}`,
        name: `DEF006 User ${String(seq)}`,
        first_name: null,
        last_name: null,
        email: `def006-${String(seq)}@example.test`,
        phone: `0122${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function makeSubject(): Promise<Subject> {
    const subjects = dataSource.getRepository(Subject);
    return await subjects.save(
      subjects.create({
        name: 'DEF006 Subject',
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

  async function makeLesson(teacherId: string, subjectId: string): Promise<Lesson> {
    seq += 1;
    const lessons = dataSource.getRepository(Lesson);
    return await lessons.save(
      lessons.create({
        title: `DEF006 Lesson ${String(seq)}`,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
  }

  /**
   * Link a verified guardian to a student.
   *
   * Preferences live on the LINK, so two guardians of the same student can
   * disagree — which is exactly what the relationship-specific tests below
   * exercise.
   */
  async function linkGuardian(
    studentId: string,
    options: {
      preferences?: Partial<Record<ParentEventType, boolean>>;
      verified?: boolean;
      optedOut?: boolean;
      receivesNotifications?: boolean;
      language?: PreferredLanguage;
    } = {},
  ): Promise<Guardian> {
    seq += 1;
    const guardianRepo = dataSource.getRepository(Guardian);
    const linkRepo = dataSource.getRepository(StudentGuardian);

    const guardian = await guardianRepo.save(
      guardianRepo.create({
        phone_e164: `+2010${String(seq).padStart(8, '0')}`,
        full_name: `Guardian ${String(seq)}`,
        preferred_language: options.language ?? PreferredLanguage.AR,
        verification_status:
          options.verified === false
            ? GuardianVerificationStatus.UNVERIFIED
            : GuardianVerificationStatus.VERIFIED,
        verified_at: options.verified === false ? null : new Date(),
        whatsapp_capable: true,
        opted_out_at: options.optedOut === true ? new Date() : null,
      }),
    );

    await linkRepo.save(
      linkRepo.create({
        student_id: studentId,
        guardian_id: guardian.id,
        relationship: GuardianRelationship.FATHER,
        is_primary: false,
        receives_notifications: options.receivesNotifications ?? true,
        notification_preferences: options.preferences ?? {},
      }),
    );

    return guardian;
  }

  /**
   * Raw inserts, for two reasons: `entered_at` / `marked_at` are
   * `CreateDateColumn`s the ORM would overwrite with "now", and both are
   * `timestamp WITHOUT time zone`.
   *
   * The explicit `::timestamptz AT TIME ZONE 'UTC'` writes the UTC wall-clock
   * reading of the instant, which is the convention those columns hold. Passing
   * the ISO string straight in would *also* work — Postgres discards the `Z` —
   * but silently, which is precisely the trap the aggregator's predicates exist
   * to avoid, so the intent is spelled out here too.
   */
  async function addSession(
    studentId: string,
    lessonId: string,
    enteredAt: Date,
    durationSeconds: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO lesson_sessions (student_id, lesson_id, entered_at, duration_seconds)
       VALUES ($1, $2, (CAST($3 AS timestamptz) AT TIME ZONE 'UTC'), $4)`,
      [studentId, lessonId, enteredAt.toISOString(), durationSeconds],
    );
  }

  async function addAttendance(
    studentId: string,
    lessonId: string,
    status: string,
    markedAt: Date,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO attendance_records (student_id, lesson_id, status, marked_at)
       VALUES ($1, $2, $3, (CAST($4 AS timestamptz) AT TIME ZONE 'UTC'))`,
      [studentId, lessonId, status, markedAt.toISOString()],
    );
  }

  async function addCompletedLesson(
    studentId: string,
    lessonId: string,
    completedAt: Date | null,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO lesson_progress
         (student_id, lesson_id, watched_duration, total_duration, progress_percent,
          completed, completed_at, last_watched_at)
       VALUES ($1, $2, 600, 600, 100, true, $3, now())`,
      [studentId, lessonId, completedAt === null ? null : completedAt.toISOString()],
    );
  }

  /* ---------------------------- period aggregation -------------------------- */

  describe('period aggregation', () => {
    it('counts only activity inside the half-open period window', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const lesson = await makeLesson(teacher.id, subject.id);

      // One millisecond before the period opens — must NOT count.
      await addSession(student.id, lesson.id, new Date(weekly.startsAt.getTime() - 1), 600);
      // Exactly at the inclusive lower bound — MUST count.
      await addSession(student.id, lesson.id, weekly.startsAt, 1200);
      // Inside.
      await addSession(
        student.id,
        lesson.id,
        new Date(weekly.startsAt.getTime() + 86_400_000),
        600,
      );
      // Exactly at the exclusive upper bound — must NOT count (it belongs to
      // the next period; counting it here would double-report it).
      await addSession(student.id, lesson.id, weekly.endsAt, 9999);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.study.sessions).toBe(2);
      expect(payload.study.minutes).toBe(30); // (1200 + 600) / 60
      expect(payload.hasActivity).toBe(true);
    });

    it('counts distinct lessons, not distinct sessions', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const first = await makeLesson(teacher.id, subject.id);
      const second = await makeLesson(teacher.id, subject.id);

      const inside = new Date(weekly.startsAt.getTime() + 3_600_000);
      await addSession(student.id, first.id, inside, 300);
      await addSession(student.id, first.id, inside, 300);
      await addSession(student.id, second.id, inside, 300);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.study.sessions).toBe(3);
      expect(payload.study.lessons).toBe(2);
    });

    it('groups attendance by its stored status', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const inside = new Date(weekly.startsAt.getTime() + 3_600_000);

      // One attendance row per lesson: a partial unique index enforces it.
      for (const status of ['present', 'present', 'absent', 'late', 'excused']) {
        const lesson = await makeLesson(teacher.id, subject.id);
        await addAttendance(student.id, lesson.id, status, inside);
      }
      // Outside the window.
      const stale = await makeLesson(teacher.id, subject.id);
      await addAttendance(student.id, stale.id, 'absent', new Date(weekly.endsAt.getTime() + 1000));

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.attendance).toEqual({
        present: 2,
        absent: 1,
        late: 1,
        excused: 1,
        total: 5,
      });
    });

    it('counts a lesson completion in the period it was completed, not re-watched', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();

      const thisWeek = await makeLesson(teacher.id, subject.id);
      const longAgo = await makeLesson(teacher.id, subject.id);
      const preMigration = await makeLesson(teacher.id, subject.id);

      await addCompletedLesson(student.id, thisWeek.id, new Date(weekly.startsAt.getTime() + 1000));
      // Completed months ago. `updated_at` is NOW (the row was just written),
      // so an implementation keyed on `updated_at` would wrongly count it —
      // this is the exact bug `completed_at` exists to prevent.
      await addCompletedLesson(student.id, longAgo.id, new Date('2026-02-01T00:00:00.000Z'));
      // Pre-migration row with no recorded completion instant.
      await addCompletedLesson(student.id, preMigration.id, null);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.study.completed).toBe(1);
    });

    it('reports a genuinely quiet period as empty rather than fabricating activity', async () => {
      const student = await makeUser(UserRole.STUDENT);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.hasActivity).toBe(false);
      expect(payload.study).toEqual({ sessions: 0, lessons: 0, minutes: 0, completed: 0 });
      expect(payload.exams.averagePercent).toBeNull();
      expect(payload.homework.averagePercent).toBeNull();
    });

    it('scopes strictly to one student', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const sibling = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const lesson = await makeLesson(teacher.id, subject.id);
      const inside = new Date(weekly.startsAt.getTime() + 3_600_000);

      await addSession(student.id, lesson.id, inside, 600);
      await addSession(sibling.id, lesson.id, inside, 6000);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.study.sessions).toBe(1);
      expect(payload.study.minutes).toBe(10);
    });
  });

  /* --------------------------- calendar boundaries -------------------------- */

  describe('calendar boundaries', () => {
    it('uses a full calendar month, not a rolling 30 days', async () => {
      const monthly = resolveMonthlyPeriod(new Date('2026-08-05T06:00:00.000Z'), CAIRO);
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const lesson = await makeLesson(teacher.id, subject.id);

      // 1 July, local — inside a calendar month but OUTSIDE a 30-day window
      // measured back from 5 August. This is the assertion that distinguishes
      // "monthly" from "last 30 days".
      await addSession(student.id, lesson.id, monthly.startsAt, 600);
      // 30 June, local — the day before the month opens.
      await addSession(student.id, lesson.id, new Date(monthly.startsAt.getTime() - 1000), 600);

      const payload = await aggregator.aggregate(student.id, monthly);

      expect(monthly.startDate).toBe('2026-07-01');
      expect(monthly.endDate).toBe('2026-07-31');
      expect(payload.study.sessions).toBe(1);
    });

    it('places local-evening activity in the local day, not the UTC one', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const lesson = await makeLesson(teacher.id, subject.id);

      // 23:30 Cairo on Sunday 9 August = 20:30Z, the last half hour of the
      // week. A UTC-keyed period would already have rolled over.
      const lateSundayLocal = new Date(weekly.endsAt.getTime() - 1_800_000);
      await addSession(student.id, lesson.id, lateSundayLocal, 600);

      // 00:30 Cairo on Monday 10 August — the next period.
      const earlyMondayLocal = new Date(weekly.endsAt.getTime() + 1_800_000);
      await addSession(student.id, lesson.id, earlyMondayLocal, 600);

      const payload = await aggregator.aggregate(student.id, weekly);

      expect(payload.study.sessions).toBe(1);
    });
  });

  /* ------------------------------- idempotency ------------------------------ */

  describe('idempotency', () => {
    async function studentWithGuardian(): Promise<string> {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id);
      return student.id;
    }

    function buildJob(
      studentId: string,
      type = ParentReportType.WEEKLY,
    ): Parameters<ParentReportProcessor['process']>[0] {
      return {
        name: 'build-parent-report',
        data: { studentId, reportType: type, resolvedAt: MONDAY.toISOString() },
        opts: { attempts: 3 },
      } as unknown as Parameters<ParentReportProcessor['process']>[0];
    }

    it('produces exactly one report and one delivery across repeated runs', async () => {
      const studentId = await studentWithGuardian();

      // Three runs: the scheduler firing twice, plus a worker retry.
      await processor.process(buildJob(studentId));
      await processor.process(buildJob(studentId));
      await processor.process(buildJob(studentId));

      const rows = await dataSource
        .getRepository(ParentReport)
        .find({ where: { student_id: studentId } });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe(ParentReportStatus.DISPATCHED);
      expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    });

    it('enforces one report per period in the database, not just in the worker', async () => {
      const studentId = await studentWithGuardian();

      // Two concurrent claims race on the unique index. Exactly one may win —
      // this is the guarantee everything else is layered on.
      const [first, second] = await Promise.all([
        reports.claim(studentId, weekly),
        reports.claim(studentId, weekly),
      ]);

      const rows = await dataSource
        .getRepository(ParentReport)
        .find({ where: { student_id: studentId } });
      expect(rows).toHaveLength(1);
      expect(first.report.id).toBe(second.report.id);
    });

    it('refuses to re-claim a period that already reached a guardian', async () => {
      const studentId = await studentWithGuardian();

      const claim = await reports.claim(studentId, weekly);
      await reports.markDispatched(claim.report.id, 1);

      const second = await reports.claim(studentId, weekly);

      expect(second.claimed).toBe(false);
      expect(second.report.status).toBe(ParentReportStatus.DISPATCHED);
    });

    it('re-claims a failed period so a retry can finish it', async () => {
      const studentId = await studentWithGuardian();

      const claim = await reports.claim(studentId, weekly);
      await reports.markFailed(claim.report.id, 'connection reset');

      const retry = await reports.claim(studentId, weekly);

      expect(retry.claimed).toBe(true);
      expect(retry.report.id).toBe(claim.report.id);
    });

    it('keeps weekly and monthly reports independent for the same student', async () => {
      const studentId = await studentWithGuardian();

      await processor.process(buildJob(studentId, ParentReportType.WEEKLY));
      await processor.process(buildJob(studentId, ParentReportType.MONTHLY));

      const rows = await dataSource
        .getRepository(ParentReport)
        .find({ where: { student_id: studentId } });

      expect(rows.map((row) => row.report_type).sort()).toEqual(['monthly', 'weekly']);
      expect(enqueueDelivery).toHaveBeenCalledTimes(2);
    });

    it('gives each child of one guardian its own delivery subject', async () => {
      // A guardian with two children must receive two reports per period. If
      // the subject omitted the student, both would collapse onto one
      // idempotency key in `parent_messages` and one child would be silenced.
      const guardianPhoneOwner = await makeUser(UserRole.STUDENT);
      const sibling = await makeUser(UserRole.STUDENT);
      await linkGuardian(guardianPhoneOwner.id);
      await linkGuardian(sibling.id);

      await processor.process(buildJob(guardianPhoneOwner.id));
      await processor.process(buildJob(sibling.id));

      const subjects = enqueueDelivery.mock.calls.map(
        (call) => (call[0] as { subjectId: string }).subjectId,
      );

      expect(new Set(subjects).size).toBe(2);
      expect(subjects[0]).toContain(guardianPhoneOwner.id);
      expect(subjects[1]).toContain(sibling.id);
    });

    it('does not let one student’s failure block the others', async () => {
      const healthy = await studentWithGuardian();
      const broken = await studentWithGuardian();

      const failing = jest
        .spyOn(aggregator, 'aggregate')
        .mockImplementationOnce(() => Promise.reject(new Error('simulated aggregation failure')));

      await expect(processor.process(buildJob(broken))).rejects.toThrow('simulated aggregation');
      failing.mockRestore();

      // The next student's job is entirely unaffected — one student is one job.
      await processor.process(buildJob(healthy));

      const rows = await dataSource.getRepository(ParentReport).find();
      const byStudent = new Map(rows.map((row) => [row.student_id, row.status]));

      expect(byStudent.get(broken)).toBe(ParentReportStatus.FAILED);
      expect(byStudent.get(healthy)).toBe(ParentReportStatus.DISPATCHED);
      expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    });
  });

  /* --------------------------- guardian preferences ------------------------- */

  describe('guardian preferences', () => {
    it('selects a student when the weekly toggle is ON', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, {
        preferences: { [ParentEventType.WEEKLY_REPORT]: true },
      });

      const candidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );

      expect(candidates).toContain(student.id);
    });

    it('omits a student when the weekly toggle is OFF', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, {
        preferences: { [ParentEventType.WEEKLY_REPORT]: false },
      });

      const candidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );

      expect(candidates).not.toContain(student.id);
    });

    it('treats an absent preference key as the documented default (ON)', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, { preferences: {} });

      const candidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );

      expect(candidates).toContain(student.id);
    });

    it('keeps weekly and monthly preferences independent', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, {
        preferences: {
          [ParentEventType.WEEKLY_REPORT]: true,
          [ParentEventType.MONTHLY_REPORT]: false,
        },
      });

      const weeklyCandidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );
      const monthlyCandidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.MONTHLY_REPORT,
        { limit: 100 },
      );

      expect(weeklyCandidates).toContain(student.id);
      expect(monthlyCandidates).not.toContain(student.id);
    });

    it('is per relationship: one guardian opting out does not silence the other', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, {
        preferences: { [ParentEventType.WEEKLY_REPORT]: false },
      });
      await linkGuardian(student.id, {
        preferences: { [ParentEventType.WEEKLY_REPORT]: true },
      });

      const candidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );
      const targets = await guardians.findNotificationTargets(
        student.id,
        ParentEventType.WEEKLY_REPORT,
      );

      expect(candidates).toContain(student.id);
      // Only the guardian who wants it is a target.
      expect(targets).toHaveLength(1);
    });

    it.each([
      ['unverified', { verified: false }],
      ['opted out', { optedOut: true }],
      ['notifications switched off for the link', { receivesNotifications: false }],
    ])('excludes a guardian who is %s', async (_label, options) => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id, options);

      const candidates = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 100 },
      );

      expect(candidates).not.toContain(student.id);
    });

    it('skips the report entirely when eligibility lapses between sweep and build', async () => {
      const student = await makeUser(UserRole.STUDENT);
      const guardian = await linkGuardian(student.id);

      // The sweep already queued this student; the guardian then opts out.
      await dataSource.query(`UPDATE guardians SET opted_out_at = now() WHERE id = $1`, [
        guardian.id,
      ]);

      await processor.process({
        name: 'build-parent-report',
        data: {
          studentId: student.id,
          reportType: ParentReportType.WEEKLY,
          resolvedAt: MONDAY.toISOString(),
        },
        opts: { attempts: 3 },
      } as unknown as Parameters<ParentReportProcessor['process']>[0]);

      const row = await dataSource
        .getRepository(ParentReport)
        .findOne({ where: { student_id: student.id } });

      expect(row?.status).toBe(ParentReportStatus.SKIPPED);
      expect(enqueueDelivery).not.toHaveBeenCalled();
    });

    it('pages the candidate query with a keyset cursor', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const student = await makeUser(UserRole.STUDENT);
        await linkGuardian(student.id);
        created.push(student.id);
      }

      const firstPage = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 2 },
      );
      const secondPage = await guardians.findStudentsWithEligibleGuardians(
        ParentEventType.WEEKLY_REPORT,
        { limit: 2, afterStudentId: firstPage[firstPage.length - 1] },
      );

      expect(firstPage).toHaveLength(2);
      expect(secondPage).toHaveLength(2);
      // Pages must not overlap, or students would be reported twice.
      expect(firstPage.some((id) => secondPage.includes(id))).toBe(false);
      // Ordered ascending, which is what makes the cursor total.
      expect([...firstPage].sort()).toEqual(firstPage);
      expect(created).toEqual(expect.arrayContaining([...firstPage, ...secondPage]));
    });
  });

  /* ---------------------------- end-to-end lifecycle ------------------------ */

  describe('lifecycle', () => {
    it('carries the aggregated counts through to the guardian delivery payload', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const student = await makeUser(UserRole.STUDENT);
      const subject = await makeSubject();
      const lesson = await makeLesson(teacher.id, subject.id);
      await linkGuardian(student.id, { language: PreferredLanguage.EN });

      const inside = new Date(weekly.startsAt.getTime() + 3_600_000);
      await addSession(student.id, lesson.id, inside, 1_800);
      await addAttendance(student.id, lesson.id, 'present', inside);
      await addCompletedLesson(student.id, lesson.id, inside);

      await processor.process({
        name: 'build-parent-report',
        data: {
          studentId: student.id,
          reportType: ParentReportType.WEEKLY,
          resolvedAt: MONDAY.toISOString(),
        },
        opts: { attempts: 3 },
      } as unknown as Parameters<ParentReportProcessor['process']>[0]);

      const delivery = enqueueDelivery.mock.calls[0]?.[0] as {
        eventType: ParentEventType;
        subjectId: string;
        variables: Record<string, unknown>;
      };

      expect(delivery.eventType).toBe(ParentEventType.WEEKLY_REPORT);
      expect(delivery.subjectId).toBe(`${student.id}:w2026-08-03`);
      expect(delivery.variables).toMatchObject({
        periodStart: '2026-08-03',
        periodEnd: '2026-08-09',
        timeZone: CAIRO,
      });
      expect(delivery.variables['report']).toMatchObject({
        study: { sessions: 1, lessons: 1, minutes: 30, completed: 1 },
        attendance: { present: 1, total: 1 },
        hasActivity: true,
      });

      // The stored row holds counts only — never rendered prose, so the same
      // report can be read out in either language.
      const row = await dataSource
        .getRepository(ParentReport)
        .findOneOrFail({ where: { student_id: student.id } });
      expect(row.status).toBe(ParentReportStatus.DISPATCHED);
      expect(row.recipient_count).toBe(1);
      expect(row.time_zone).toBe(CAIRO);
      expect(JSON.stringify(row.payload)).not.toContain('report for');
    });

    it('records the period boundaries it actually used', async () => {
      const student = await makeUser(UserRole.STUDENT);
      await linkGuardian(student.id);

      await processor.process({
        name: 'build-parent-report',
        data: {
          studentId: student.id,
          reportType: ParentReportType.WEEKLY,
          resolvedAt: MONDAY.toISOString(),
        },
        opts: { attempts: 3 },
      } as unknown as Parameters<ParentReportProcessor['process']>[0]);

      const row = await dataSource
        .getRepository(ParentReport)
        .findOneOrFail({ where: { student_id: student.id } });

      expect(row.period_key).toBe('w2026-08-03');
      expect(row.period_start.toISOString()).toBe(weekly.startsAt.toISOString());
      expect(row.period_end.toISOString()).toBe(weekly.endsAt.toISOString());
    });
  });
});
